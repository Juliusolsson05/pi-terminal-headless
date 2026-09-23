import { afterEach, describe, expect, it } from 'vitest'

import { PiTerminalHeadless } from './PiTerminalHeadless.js'
import type { SemanticEvent } from './channels/types.js'
import { listLiveFixtures, loadLiveFixture, type LiveFixture } from './testing/fixtures.js'
import { referenceActiveBranch } from './testing/oracle.js'
import { createReplaySandbox, FakePty, playReplay, waitUntil, type ReplaySandbox } from './testing/replay.js'

// The root class end to end over every Stage 0 recording, with real sockets
// and real files, ordered exactly as pi produced them. Expectations are the
// recording's own facts (its agent_settled count, its final files' branches)
// and the ordering rules the renderer depends on — never the package's output.

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Observed =
  | { kind: 'entry'; id: string; file: string }
  | { kind: 'history'; what: 'reset' | 'caught-up'; file: string }
  | { kind: 'semantic'; event: SemanticEvent }
  | { kind: 'activity'; active: boolean | null; status: string }
  | { kind: 'switch'; to: string }

async function replay(fixture: LiveFixture, options: { untilT?: number; noBridge?: boolean; resumeExisting?: string } = {}) {
  const sandbox: ReplaySandbox = createReplaySandbox(fixture, options.resumeExisting ? { resumeExisting: options.resumeExisting } : {})
  const pty = new FakePty()
  const headless = new PiTerminalHeadless({ pty, launch: sandbox.launch, fastPollMs: 20, slowPollMs: 200, discoverPollMs: 20, heartbeatMs: 0, bridgeConnectDeadlineMs: 500 })
  const observed: Observed[] = []
  headless.on('entry', ({ row, file }) => observed.push({ kind: 'entry', id: row.id, file }))
  headless.on('history', ({ kind, file }) => observed.push({ kind: 'history', what: kind, file }))
  headless.on('semantic', event => observed.push({ kind: 'semantic', event }))
  headless.on('activity', ({ active, status }) => observed.push({ kind: 'activity', active, status }))
  headless.on('session-switched', ({ to }) => observed.push({ kind: 'switch', to: to.file }))
  const liveStates: Array<{ connected: boolean; reason?: string }> = []
  headless.on('live-state', state => liveStates.push(state))
  let exited = false
  headless.on('exit', () => { exited = true })
  cleanups.push(async () => {
    await headless.stop()
    sandbox.cleanup()
  })
  await headless.start()
  await playReplay(fixture, sandbox, { ...(options.untilT !== undefined ? { untilT: options.untilT } : {}), ...(options.noBridge ? { noBridge: true } : {}) })
  return { sandbox, pty, headless, observed, liveStates, isExited: () => exited }
}

/** What a consumer that applies resets would hold for `file` at the end. */
function consumerView(observed: Observed[], file: string): string[] {
  const view: string[] = []
  for (const o of observed) {
    if (o.kind === 'history' && o.file === file && o.what === 'reset') view.length = 0
    if (o.kind === 'entry' && o.file === file) view.push(o.id)
  }
  return view
}

const firstProcessEnd = (fixture: LiveFixture) => fixture.exits.find(exit => exit.process === 1)?.t

describe('PiTerminalHeadless over the recordings', () => {
  const singleProcess = listLiveFixtures().map(n => n.replace(/\.json$/, '')).filter(name => !['trust', 'resume'].includes(name))

  for (const name of singleProcess) {
    it(`${name}: the consumer ends with the branch pi would load, and every turn completes after its answer`, async () => {
      const fixture = loadLiveFixture(name)
      const { observed, pty, sandbox, isExited } = await replay(fixture)
      const settles = fixture.events.filter(e => e.name === 'agent_settled').length
      await waitUntil(() => observed.filter(o => o.kind === 'semantic' && o.event.type === 'turn_completed').length >= settles, 5_000, 'turn_completed count')
      // The final file(s): the consumer's view of the file pi ended in equals
      // pi's own branch of that file.
      const lastStart = [...fixture.events].reverse().find(e => e.name === 'session_start')
      const lastFile = lastStart?.sessionFile as string
      await waitUntil(() => consumerView(observed, sandbox.mapPath(lastFile)).length === referenceActiveBranch(fixture.files[lastFile]!).length, 5_000, 'branch caught up')
      expect(consumerView(observed, sandbox.mapPath(lastFile))).toEqual(referenceActiveBranch(fixture.files[lastFile]!).map(row => row.id))

      // Answer before end: each turn_completed follows the entry of the leaf
      // pi reported for that run's agent_settled.
      const leaves = fixture.events.filter(e => e.name === 'agent_settled').map(e => e.leafId as string)
      const completedAt = observed.flatMap((o, index) => (o.kind === 'semantic' && o.event.type === 'turn_completed' ? [index] : []))
      leaves.forEach((leaf, turn) => {
        const entryIndex = observed.findIndex(o => o.kind === 'entry' && o.id === leaf)
        expect(entryIndex, `turn ${turn} answer ${leaf} emitted`).toBeGreaterThan(-1)
        expect(entryIndex).toBeLessThan(completedAt[turn]!)
      })

      // Never idle inside a turn; turn_started/turn_completed alternate.
      let open = false
      for (const o of observed) {
        if (o.kind === 'semantic' && o.event.type === 'turn_started') {
          expect(open).toBe(false)
          open = true
        }
        if (o.kind === 'semantic' && o.event.type === 'turn_completed') open = false
        if (o.kind === 'activity' && o.status === 'idle') expect(open).toBe(false)
      }

      pty.exit(0)
      await waitUntil(isExited, 5_000, 'exit')
    })
  }

  it('new-session and fork: the switch is announced, and entries of the old file stop', async () => {
    for (const name of ['new-session', 'fork']) {
      const fixture = loadLiveFixture(name)
      const { observed, sandbox } = await replay(fixture)
      const starts = fixture.events.filter(e => e.name === 'session_start')
      await waitUntil(() => observed.some(o => o.kind === 'switch'), 5_000, 'switch')
      expect(observed.filter(o => o.kind === 'switch').map(o => (o as { to: string }).to)).toEqual([sandbox.mapPath(starts[1]!.sessionFile as string)])
      const switchAt = observed.findIndex(o => o.kind === 'switch')
      const oldFile = sandbox.mapPath(starts[0]!.sessionFile as string)
      expect(observed.slice(switchAt).some(o => o.kind === 'entry' && o.file === oldFile)).toBe(false)
    }
  })

  it('resume (first process): /resume back into A resets to A’s branch', async () => {
    const fixture = loadLiveFixture('resume')
    const { observed, sandbox } = await replay(fixture, { untilT: firstProcessEnd(fixture)! })
    const fileA = fixture.events.find(e => e.name === 'session_start')!.sessionFile as string
    await waitUntil(() => observed.filter(o => o.kind === 'switch').length === 2, 5_000, 'two switches')
    await waitUntil(() => consumerView(observed, sandbox.mapPath(fileA)).length > 0, 5_000, 'A re-emitted')
    // A at the time of the second process launch = A's rows up to its 3rd user turn.
    const view = consumerView(observed, sandbox.mapPath(fileA))
    expect(view.slice(0, 4)).toEqual(referenceActiveBranch(fixture.files[fileA]!).slice(0, 4).map(row => row.id))
  })

  it('attaching to an existing session (restart) does not re-emit its history — the host loads that itself', async () => {
    const fixture = loadLiveFixture('resume')
    const fileA = fixture.events.find(e => e.name === 'session_start')!.sessionFile as string
    // Replay the SECOND process (relaunch by id) against a file that already holds process 1's rows.
    const secondStart = fixture.events.filter(e => e.name === 'session_start')[3]!
    const sandbox = createReplaySandbox(fixture, { resumeExisting: fileA })
    cleanups.push(() => sandbox.cleanup())
    const rows = fixture.files[fileA]!
    const lengths = fixture.fileRowBytes[fileA]!
    let end = 0
    const existing = rows.filter((_, i) => (end += lengths[i]!) <= secondStart.fileBytes!)
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    mkdirSync(dirname(sandbox.mapPath(fileA)), { recursive: true })
    writeFileSync(sandbox.mapPath(fileA), existing.map(row => JSON.stringify(row) + '\n').join(''))
    const pty = new FakePty()
    const headless = new PiTerminalHeadless({ pty, launch: sandbox.launch, fastPollMs: 20, heartbeatMs: 0 })
    const entries: string[] = []
    headless.on('entry', ({ row }) => entries.push(row.id))
    cleanups.push(() => headless.stop())
    await headless.start()
    await new Promise(r => setTimeout(r, 150))
    expect(entries).toEqual([])
    // New rows after attach DO arrive.
    const { appendFileSync } = await import('node:fs')
    const next = rows[existing.length]!
    appendFileSync(sandbox.mapPath(fileA), JSON.stringify(next) + '\n')
    await waitUntil(() => entries.length === 1, 2_000, 'appended row')
    expect(entries).toEqual([next.id])
  })

  it('tree: abandoned turns are replaced by a reset, never left in the consumer’s view', async () => {
    const fixture = loadLiveFixture('tree')
    const { observed, sandbox } = await replay(fixture)
    const [file] = Object.keys(fixture.files)
    await waitUntil(() => observed.filter(o => o.kind === 'semantic' && o.event.type === 'turn_completed').length === 4, 5_000, 'four turns')
    expect(observed.filter(o => o.kind === 'history' && o.what === 'reset').length).toBeGreaterThanOrEqual(2)
    await waitUntil(() => consumerView(observed, sandbox.mapPath(file!)).length === referenceActiveBranch(fixture.files[file!]!).length, 5_000, 'final branch')
    expect(consumerView(observed, sandbox.mapPath(file!))).toEqual(referenceActiveBranch(fixture.files[file!]!).map(row => row.id))
  })

  it('no bridge: the transcript still arrives (found by directory scan), status is unknown, prompts refuse, live-state says why', async () => {
    const fixture = loadLiveFixture('tool')
    const { observed, headless, liveStates, sandbox } = await replay(fixture, { noBridge: true })
    const [file] = Object.keys(fixture.files)
    await waitUntil(() => consumerView(observed, sandbox.mapPath(file!)).length === referenceActiveBranch(fixture.files[file!]!).length, 5_000, 'rows via scan')
    expect(observed.some(o => o.kind === 'semantic')).toBe(false)
    expect(headless.getActivity().status).toBe('unknown')
    await waitUntil(() => liveStates.length > 0, 2_000, 'live-state')
    expect(liveStates[0]).toEqual({ connected: false, reason: 'bridge-unreachable' })
    await expect(headless.submitPrompt('hi')).resolves.toMatchObject({ ok: false, reason: 'no-live-channel' })
  })

  it('kill mid-turn: exit ends the open turn and reports idle after it', async () => {
    const fixture = loadLiveFixture('kill')
    const { observed, pty, isExited } = await replay(fixture)
    pty.exit(0, 9)
    await waitUntil(isExited, 5_000, 'exit')
    const starts = observed.filter(o => o.kind === 'semantic' && o.event.type === 'turn_started').length
    const completes = observed.filter(o => o.kind === 'semantic' && o.event.type === 'turn_completed').length
    expect(completes).toBe(starts)
    expect(observed.at(-1)).toMatchObject({ kind: 'activity', active: false })
  })

  it('stop() is idempotent before, during and after start()', async () => {
    const fixture = loadLiveFixture('plain')
    const sandbox = createReplaySandbox(fixture)
    cleanups.push(() => sandbox.cleanup())
    const a = new PiTerminalHeadless({ pty: new FakePty(), launch: sandbox.launch })
    await a.stop()
    await a.stop()
    await a.start() // after stop: a no-op, never listens
    const b = new PiTerminalHeadless({ pty: new FakePty(), launch: { ...sandbox.launch, socketPath: `${sandbox.launch.socketPath}2` } })
    const starting = b.start()
    await b.stop()
    await starting
    await b.stop()
  })
})
