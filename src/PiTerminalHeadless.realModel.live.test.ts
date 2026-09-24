// Real-model live tier: the whole package against the REAL pi talking to a
// REAL model, through the public API exactly as Agent Code drives it.
//
//   PI_TERMINAL_HEADLESS_REAL_MODEL=1 PI_BINARY=/abs/pi NODE_PTY_PATH=<node-ABI node-pty> \
//     [PI_REAL_MODEL_OUT=/abs/dir] npm run test:live -- src/PiTerminalHeadless.realModel.live.test.ts
//
// WHY this exists next to PiTerminalHeadless.live.test.ts: every other tier
// (the Stage 0 recordings, the corpus, the faux-model live tier) runs Pi's
// scripted faux provider, because the machine that built the provider had no
// Pi login. A real model differs in ways the faux one cannot show: streamed
// thinking blocks, real tool-call argument shapes, usage/cost fields on every
// assistant row, turns that take seconds rather than milliseconds, and a
// compaction whose summary is actually generated. This tier checks the
// host-observable contract under those conditions.
//
// Credentials: the sandbox gets the user's API-KEY logins from ~/.pi/agent
// auth.json, plus settings.json and models-store.json (which provider/model is
// the default), in a temp PI_CODING_AGENT_DIR that is deleted afterwards.
// Nothing is sent anywhere Pi would not send it itself.
//
// WHY API keys only (PR review, finding 1): pi refreshes an expiring OAuth
// login and writes the rotated token back to the store it read it from,
// under that store's lock. A copied store would rotate the token in the
// sandbox, which is then deleted, leaving the user's real login holding a
// consumed refresh token. An API key never rotates, so a copy is inert. If
// the default provider logs in with OAuth the tier skips and says why. It costs a few real model calls, so it
// is opt-in and never runs in CI. PI_REAL_MODEL_OUT keeps the session files it
// wrote, so the parser codec and the app mapper can be run over real rows.
//
// Assertions are deliberately about the contract, never about what the model
// says: a real model's wording is not a fixture.

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { PiTerminalHeadless, type PiTerminalError } from './PiTerminalHeadless.js'
import type { SemanticEvent } from './channels/types.js'
import { preparePiTerminalLaunch } from './launch/prepareLaunch.js'
import { readPiBranch } from './transcript/history.js'
import type { PiSessionRow } from './transcript/SessionFile.js'
import { waitUntil } from './testing/replay.js'

const USER_AGENT_DIR = process.env.PI_REAL_MODEL_AGENT_DIR ?? join(homedir(), '.pi', 'agent')

/** The user's API-key logins only; null (skip) when the default provider's login is not one. */
function apiKeyLogins(): Record<string, unknown> | null {
  try {
    const auth = JSON.parse(readFileSync(join(USER_AGENT_DIR, 'auth.json'), 'utf8')) as Record<string, { type?: string }>
    const settings = existsSync(join(USER_AGENT_DIR, 'settings.json')) ? JSON.parse(readFileSync(join(USER_AGENT_DIR, 'settings.json'), 'utf8')) as { defaultProvider?: string } : {}
    const keys = Object.fromEntries(Object.entries(auth).filter(([, login]) => login?.type === 'api_key'))
    if (settings.defaultProvider && !(settings.defaultProvider in keys)) {
      console.warn(`real-model tier skipped: ${settings.defaultProvider} is not an API-key login (an OAuth copy would rotate the real login's token)`)
      return null
    }
    return Object.keys(keys).length > 0 ? keys : null
  } catch {
    return null
  }
}

const LOGINS = process.env.PI_TERMINAL_HEADLESS_REAL_MODEL === '1' && Boolean(process.env.PI_BINARY) ? apiKeyLogins() : null
const LIVE = LOGINS !== null
const BRIDGE = fileURLToPath(new URL('./bridge/extension.ts', import.meta.url))
const OUT = process.env.PI_REAL_MODEL_OUT
// A real turn takes seconds, and a slow provider tens of seconds.
const TURN_MS = 150_000

type Pty = { pid: number; write(d: string): void; resize(c: number, r: number): void; kill(s?: string): void; onData(l: (d: string) => void): unknown; onExit(l: (e: { exitCode: number; signal?: number }) => void): { dispose(): void } }

const cleanups: Array<() => void | Promise<void>> = []
// Every step runs even when an earlier one throws: the export runs first and
// may fail on an unwritable PI_REAL_MODEL_OUT, and that must not skip killing
// pi or deleting the credential copy.
afterEach(async () => {
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw failures[0]
})

async function spawnRealPi(label: string) {
  const require = createRequire(import.meta.url)
  const nodePty = require(process.env.NODE_PTY_PATH ?? 'node-pty') as { spawn(f: string, a: string[], o: object): Pty }
  const { Terminal } = require('@xterm/headless') as { Terminal: new (o: object) => { write(d: string): void; onData(l: (d: string) => void): void } }
  // Outside any repository: Pi loads AGENTS.md and asks for trust from
  // ancestor directories (Stage 0 tooling note).
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'acpi-real-'))
  // Registered FIRST (PR review, finding 3): whatever fails after this point,
  // a bad PI_BINARY or a malformed settings file, the credential copy goes.
  // Runs last, after the pi teardown registered below.
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  for (const d of ['home', 'agent', 'project']) mkdirSync(join(root, d), { recursive: true })
  writeFileSync(join(root, 'agent', 'auth.json'), JSON.stringify(LOGINS), { mode: 0o600 })
  for (const file of ['settings.json', 'models-store.json']) {
    if (existsSync(join(USER_AGENT_DIR, file))) copyFileSync(join(USER_AGENT_DIR, file), join(root, 'agent', file))
  }
  // WHY keepRecentTokens 1: Pi keeps the most recent ~20k tokens out of a
  // compaction, so on a session this small `/compact` is refused ("Nothing to
  // compact (session too small)") and writes nothing. Same override as the
  // Stage 0 compaction scenario; merged into the user's own settings.
  const settingsFile = join(root, 'agent', 'settings.json')
  const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) as Record<string, unknown> : {}
  writeFileSync(settingsFile, JSON.stringify({ ...settings, compaction: { ...(settings.compaction as object | undefined), keepRecentTokens: 1 } }))
  execFileSync('git', ['init', '-q'], { cwd: join(root, 'project') })
  writeFileSync(join(root, 'project', 'README.md'), 'The secret word is PERIWINKLE.\nSecond line.\n')
  // No PI_OFFLINE: the model is remote. Telemetry and the version nag stay off.
  const env = { PATH: process.env.PATH ?? '', HOME: join(root, 'home'), PI_CODING_AGENT_DIR: join(root, 'agent'), PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', TERM: 'xterm-256color' }
  const sessionId = randomUUID()
  const launch = await preparePiTerminalLaunch({ binary: process.env.PI_BINARY!, cwd: join(root, 'project'), env, sessionId, bridgeScriptPath: BRIDGE, homeDirectory: join(root, 'home') })
  const pty = nodePty.spawn(launch.binary, launch.args, { name: 'xterm-256color', cols: 120, rows: 40, cwd: join(root, 'project'), env: launch.env })
  const term = new Terminal({ cols: 120, rows: 40, allowProposedApi: true })
  term.onData(d => pty.write(d))
  pty.onData(d => term.write(d))
  const headless = new PiTerminalHeadless({ pty, launch })
  const entries: PiSessionRow[] = []
  const semantic: SemanticEvent[] = []
  const errors: PiTerminalError[] = []
  const history: Array<{ kind: string; file: string }> = []
  const switches: Array<{ to: { sessionId: string; file: string }; reason: string }> = []
  const live: Array<{ connected: boolean }> = []
  let exited = false
  headless.on('entry', ({ row }) => entries.push(row))
  headless.on('semantic', event => semantic.push(event))
  headless.on('transcript-error', error => errors.push(error))
  headless.on('history', event => history.push(event))
  headless.on('session-switched', event => switches.push(event))
  headless.on('live-state', state => live.push(state))
  headless.on('exit', () => { exited = true })
  // Teardown before start(): a start that throws still kills pi. The export
  // is its own step, so an unwritable PI_REAL_MODEL_OUT can never skip the
  // kill or the sandbox removal (PR review, finding 3).
  cleanups.push(async () => {
    try {
      if (!exited) pty.kill('SIGKILL')
    } finally {
      await headless.stop()
    }
  })
  if (OUT) {
    cleanups.push(() => {
      // Every session file pi wrote in the sandbox, not only the current one:
      // after /new the file holding the real compaction is a switch SOURCE,
      // and it is the one the codec pass most needs (PR review, finding 6).
      const dir = join(OUT, label)
      mkdirSync(dir, { recursive: true })
      const sessions = join(root, 'agent', 'sessions')
      if (!existsSync(sessions)) return
      for (const project of readdirSync(sessions)) {
        for (const file of readdirSync(join(sessions, project))) copyFileSync(join(sessions, project, file), join(dir, basename(file)))
      }
    })
  }
  await headless.start()
  await waitUntil(() => live.some(s => s.connected), 30_000, 'bridge connected')
  return { root, pty, headless, entries, semantic, errors, history, switches }
}

const count = (semantic: SemanticEvent[], type: string) => semantic.filter(e => e.type === type).length
const roleOf = (row: PiSessionRow) => (row.message as { role?: string } | undefined)?.role
const idle = (headless: PiTerminalHeadless) => headless.getActivity().active === false

async function turn(pi: Awaited<ReturnType<typeof spawnRealPi>>, text: string, completedBefore: number): Promise<void> {
  await expect(pi.headless.submitPrompt(text)).resolves.toMatchObject({ ok: true })
  await waitUntil(() => count(pi.semantic, 'turn_completed') > completedBefore && idle(pi.headless), TURN_MS, `turn after "${text.slice(0, 30)}"`)
}

describe.skipIf(!LIVE)('PiTerminalHeadless with the real pi and a real model', () => {
  it('a tool-using turn: every turn that starts completes, the pane ends idle, and what we emitted is exactly pi’s branch', async () => {
    const pi = await spawnRealPi('tool-turn')
    await turn(pi, 'Use your read tool to read README.md, then tell me the secret word in one word.', 0)

    // Paired lifecycle: a real model streams, thinks and calls tools, and the
    // semantic stream must still open and close each turn exactly once.
    expect(count(pi.semantic, 'turn_started')).toBe(count(pi.semantic, 'turn_completed'))
    const completed = pi.semantic.filter(e => e.type === 'turn_completed').at(-1) as { fullText?: string }
    expect(completed.fullText?.length ?? 0).toBeGreaterThan(0)
    expect(pi.headless.getActivity()).toMatchObject({ active: false, status: 'idle' })

    const { rows } = await readPiBranch(pi.headless.getTranscriptFile()!)
    expect(pi.entries.map(r => r.id)).toEqual(rows.map(r => r.id))
    expect(rows.map(roleOf)).toContain('toolResult')
    const last = rows.filter(r => roleOf(r) === 'assistant').at(-1)!.message as { stopReason?: string; usage?: unknown }
    expect(last.stopReason).toBe('stop')
    expect(pi.errors).toEqual([])
  }, 240_000)

  it('a prompt sent while pi is busy is queued as a follow-up and answered, never lost', async () => {
    const pi = await spawnRealPi('follow-up')
    await expect(pi.headless.submitPrompt('Count slowly from 1 to 5, one number per line.')).resolves.toMatchObject({ ok: true })
    await waitUntil(() => pi.headless.getActivity().active === true, 30_000, 'first turn running')
    // H5 from Stage 0: a busy prompt without deliverAs followUp is accepted
    // and silently dropped. The bridge must always queue it.
    // `queued` is pi's own evidence the prompt arrived while it was busy, the
    // case this test is about; `started` would mean the first turn had
    // already ended and nothing here was tested (PR review).
    await expect(pi.headless.submitPrompt('Now reply with just the word DONE.')).resolves.toEqual({ ok: true, outcome: 'queued' })
    await waitUntil(() => {
      const users = pi.entries.filter(r => roleOf(r) === 'user').length
      return users === 2 && idle(pi.headless) && count(pi.semantic, 'turn_started') === count(pi.semantic, 'turn_completed')
    }, TURN_MS * 2, 'both prompts answered')
    const { rows } = await readPiBranch(pi.headless.getTranscriptFile()!)
    expect(rows.filter(r => roleOf(r) === 'user')).toHaveLength(2)
    expect(roleOf(rows.at(-1)!)).toBe('assistant')
    expect(pi.errors).toEqual([])
  }, 400_000)

  it('/compact with a real summary, then /new: the history resets, and the pane follows pi into the new session', async () => {
    const pi = await spawnRealPi('compact-new')
    await turn(pi, 'Remember the number 4217. Reply with OK.', 0)
    const firstFile = pi.headless.getTranscriptFile()!

    await expect(pi.headless.submitPrompt('/compact')).resolves.toMatchObject({ ok: true })
    // waitUntil takes a synchronous predicate; the raw file is enough to see
    // the row land (the branch read below checks it is on the active branch).
    await waitUntil(() => readFileSync(firstFile, 'utf8').includes('"type":"compaction"') && idle(pi.headless), TURN_MS, 'compaction written')
    const compaction = (await readPiBranch(firstFile)).rows.find(r => r.type === 'compaction') as { summary?: string }
    expect(compaction.summary?.length ?? 0).toBeGreaterThan(0)

    // The conversation continues across the compaction.
    const before = count(pi.semantic, 'turn_completed')
    await turn(pi, 'What number did I ask you to remember? Digits only.', before)
    const { rows } = await readPiBranch(firstFile)
    expect(pi.entries.slice(-rows.length).map(r => r.id)).toEqual(rows.map(r => r.id))

    // Sent from the host, a built-in command is refused with its reason: this
    // run is where `/new` was first seen reaching the model as plain text.
    await expect(pi.headless.submitPrompt('/new')).resolves.toMatchObject({ ok: false, reason: 'tui-command' })
    expect(readFileSync(firstFile, 'utf8')).not.toContain('"text":"/new"')
    // Typed into the TUI, as the user does, it runs. Text and Enter are
    // written separately: Pi's editor opens its command autocomplete on "/",
    // and an Enter in the same chunk can land before the menu settles.
    pi.pty.write('/new')
    await new Promise(resolve => setTimeout(resolve, 500))
    pi.pty.write('\r')
    await waitUntil(() => pi.switches.length === 1, 30_000, 'session switched')
    expect(pi.switches[0]!.to.file).not.toBe(firstFile)
    expect(pi.history.some(h => h.kind === 'reset')).toBe(true)
    await turn(pi, 'Reply with just the word HELLO.', count(pi.semantic, 'turn_completed'))
    expect(pi.headless.getTranscriptFile()).toBe(pi.switches[0]!.to.file)
    const fresh = await readPiBranch(pi.switches[0]!.to.file)
    expect(fresh.rows.filter(r => roleOf(r) === 'user')).toHaveLength(1)
    expect(pi.errors).toEqual([])
  }, 500_000)
})
