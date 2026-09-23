import { describe, expect, it } from 'vitest'

import { bridgeEventsFromRecording } from '../testing/bridgeEvents.js'
import { listLiveFixtures, loadLiveFixture } from '../testing/fixtures.js'
import { LiveStateProjector } from './LiveStateProjector.js'
import type { LiveOutput } from './types.js'

// Expectations come from each recording's OWN events (how many agent_start /
// agent_settled pairs, which files, which dialogs) — never from the projector.

function run(name: string): LiveOutput[] {
  const projector = new LiveStateProjector()
  return bridgeEventsFromRecording(loadLiveFixture(name)).flatMap(({ event }) => projector.apply(event))
}

const of = <K extends LiveOutput['kind']>(outputs: LiveOutput[], kind: K) => outputs.filter((o): o is Extract<LiveOutput, { kind: K }> => o.kind === kind)

describe('LiveStateProjector over every recording', () => {
  for (const name of listLiveFixtures().map(n => n.replace(/\.json$/, ''))) {
    it(`${name}: one turn per agent_start → agent_settled span, never idle inside it`, () => {
      const fixture = loadLiveFixture(name)
      const starts = fixture.events.filter(e => e.name === 'agent_start').length
      const settles = fixture.events.filter(e => e.name === 'agent_settled').length
      const outputs = run(name)
      expect(of(outputs, 'turn-start')).toHaveLength(starts)
      expect(of(outputs, 'turn-end')).toHaveLength(settles)
      // Activity never reports idle while a turn is open.
      let open = false
      for (const output of outputs) {
        if (output.kind === 'turn-start') open = true
        if (output.kind === 'turn-end') open = false
        if (output.kind === 'activity' && output.status === 'idle') expect(open).toBe(false)
      }
      // turn-start / turn-end share ids and never overlap.
      const sequence = outputs.filter(o => o.kind === 'turn-start' || o.kind === 'turn-end') as Array<{ kind: string; turnId: string }>
      for (let i = 0; i + 1 < sequence.length; i += 2) {
        expect(sequence[i]!.kind).toBe('turn-start')
        expect(sequence[i + 1]).toMatchObject({ kind: 'turn-end', turnId: sequence[i]!.turnId })
      }
    })
  }
})

describe('specific recordings', () => {
  it('queued: the steer and follow-up run inside the same turn (3 model replies, 1 turn)', () => {
    const outputs = run('queued')
    expect(of(outputs, 'turn-start')).toHaveLength(2) // warm-up + the slow run holding the queued prompts
  })

  it('abort and error: reported as api-error with the stopReason as errorType, then the turn ends', () => {
    expect(of(run('abort'), 'api-error').map(e => e.errorType)).toEqual(['aborted', 'aborted'])
    const error = of(run('error'), 'api-error')
    expect(error).toEqual([expect.objectContaining({ errorType: 'error', message: 'probe: simulated provider error' })])
  })

  it('doorbells: every turn_end rings with its entry ids; none ring for message_end', () => {
    const fixture = loadLiveFixture('tool')
    const turnEnds = fixture.events.filter(e => e.name === 'turn_end')
    const rings = of(run('tool'), 'doorbell').filter(d => d.entryIds.length > 1 || turnEnds.some(t => t.messageEntryId === d.entryIds[0]))
    expect(rings.map(r => r.entryIds[0])).toEqual(expect.arrayContaining(turnEnds.map(t => t.messageEntryId)))
    // The tool-use turn names its tool result row too.
    expect(rings.some(r => r.entryIds.length === 2)).toBe(true)
  })

  it('/new, /fork and /resume each report the session pi now writes', () => {
    // resume: A → /new B → /resume A, then a relaunch of A by id. The relaunch
    // is a second pi process whose first session_start names the file the
    // projector already follows, so it is not a switch (in production each
    // process gets its own projector anyway).
    for (const [name, files] of [['new-session', 2], ['fork', 2], ['resume', 3]] as const) {
      const sessions = of(run(name), 'session')
      expect(sessions).toHaveLength(files)
      const fixture = loadLiveFixture(name)
      for (const s of sessions) expect(Object.keys(fixture.files)).toContain(s.file)
    }
  })

  it('tree: each move is a leaf change even when nothing was written', () => {
    const fixture = loadLiveFixture('tree')
    const moves = fixture.events.filter(e => e.name === 'session_tree').map(e => e.newLeafId)
    expect(of(run('tree'), 'leaf').map(l => l.leafId)).toEqual(moves)
  })

  it('dialog: pending from ui_prompt_start to ui_prompt_end', () => {
    const dialogs = of(run('dialog'), 'dialogs')
    expect(dialogs.map(d => d.dialog)).toEqual([{ kind: 'confirm', title: 'Probe dialog' }, null])
  })

  it('trust: pending from project_trust until session_start', () => {
    expect(of(run('trust'), 'dialogs').map(d => d.trustPending)).toEqual([true, false])
  })

  it('compaction: phase goes to compacting and back to idle (manual /compact runs while idle)', () => {
    const phases = of(run('compaction'), 'phase').map(p => p.phase)
    const index = phases.indexOf('compacting')
    expect(index).toBeGreaterThan(-1)
    expect(phases[index + 1]).toBe('idle')
  })

  it('kill: the open turn is closed only by endForExit, and a lost bridge is unknown, not idle', () => {
    const projector = new LiveStateProjector()
    for (const { event } of bridgeEventsFromRecording(loadLiveFixture('kill'))) projector.apply(event)
    expect(projector.currentTurnId()).not.toBeNull()
    expect(projector.bridgeLost()).toEqual([{ kind: 'activity', active: null, status: 'unknown' }])
    expect(projector.currentTurnId()).not.toBeNull()
    expect(of(projector.endForExit(), 'turn-end')).toHaveLength(1)
    expect(projector.currentTurnId()).toBeNull()
  })
})
