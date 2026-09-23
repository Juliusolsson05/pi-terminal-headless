import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { listLiveFixtures, loadLiveFixture, type LiveFixture, type RecordedEvent, type RecordedRow } from './fixtures.js'
import { isEntry, referenceActiveBranch, roles } from './oracle.js'

// These tests guard the corpus, and pin the Stage 0 findings the design
// depends on (research/census-2026-09-22.md). They are not reader tests.
//
// WHY pin findings at all: every later layer is built on them — the doorbell
// (turn_end), the one-run-one-settle rule, "a busy prompt without a delivery
// mode is silently lost", "a tree move without summary writes nothing". When a
// future Pi re-recording changes one of these facts, the failure here names
// the design assumption that broke, instead of a reader test failing
// mysteriously three layers up.

const names = listLiveFixtures()
const fixtures = new Map(names.map(name => [name.replace(/\.json$/, ''), loadLiveFixture(name)]))

function fixture(name: string): LiveFixture {
  const found = fixtures.get(name)
  if (!found) throw new Error(`missing fixture ${name}`)
  return found
}

function events(f: LiveFixture, name: string): RecordedEvent[] {
  return f.events.filter(event => event.name === name)
}

/** Row end offsets (bytes) in on-disk order, from the recorded raw lengths. */
function rowEnds(f: LiveFixture, file: string): number[] {
  let offset = 0
  return f.fileRowBytes[file]!.map(length => (offset += length))
}

/** Ids of the entry rows fully on disk when the file had `bytes` bytes. */
function idsOnDisk(f: LiveFixture, file: string, bytes: number): Set<string> {
  const ends = rowEnds(f, file)
  const rows = f.files[file]!
  return new Set(rows.filter((row, index) => isEntry(row) && ends[index]! <= bytes).map(row => row.id as string))
}

function userText(row: RecordedRow): string {
  const message = row.message as { role?: string; content?: unknown } | undefined
  if (message?.role !== 'user') return ''
  if (typeof message.content === 'string') return message.content
  return (message.content as Array<{ type?: string; text?: string }>).map(block => block.text ?? '').join('')
}

describe('live corpus', () => {
  it('covers every recorded scenario, so later tests cannot run against a partial corpus', () => {
    expect([...fixtures.keys()].sort()).toEqual([
      'abort', 'compaction', 'dialog', 'error', 'fork', 'kill', 'new-session', 'paste', 'plain', 'queued',
      'resume', 'socket', 'socket-abort', 'socket-idle-followup', 'tool', 'tree', 'trust', 'user-bash',
    ])
  })

  it('was recorded with the accepted Pi version (bump both together)', () => {
    const support = JSON.parse(readFileSync(new URL('../../support/upstream-versions.json', import.meta.url), 'utf8')) as {
      providers: { pi: { accepted: string } }
    }
    for (const f of fixtures.values()) expect(f.meta.recordedWith).toBe(support.providers.pi.accepted)
  })

  for (const [name, f] of fixtures) {
    it(`${name}: finished without a probe timeout or exception`, () => {
      expect(f.notes).toEqual([])
    })

    it(`${name}: every file is a v3 tree whose parents precede their children`, () => {
      for (const [file, rows] of Object.entries(f.files)) {
        expect(rows[0]).toMatchObject({ type: 'session', version: 3 })
        expect(f.fileRowBytes[file]).toHaveLength(rows.length)
        const seen = new Set<string>()
        for (const row of rows.slice(1)) {
          expect(typeof row.id).toBe('string')
          expect(seen.has(row.id as string)).toBe(false)
          // Monotonic along every branch: a physical line order walk never
          // meets a child before its parent (what makes line numbers usable
          // as rewind addresses on any branch).
          if (row.parentId !== null) expect(seen.has(row.parentId as string)).toBe(true)
          seen.add(row.id as string)
        }
      }
    })

    it(`${name}: the recorded file sizes agree with the rows' raw lengths`, () => {
      for (const file of Object.keys(f.files)) {
        const lastGrowth = f.growth.filter(sample => sample.file === file).at(-1)
        expect(lastGrowth?.bytes).toBe(rowEnds(f, file).at(-1))
      }
    })
  }
})

describe('Stage 0 findings the pipeline depends on', () => {
  it('H1: --session-id <fresh uuid> creates <timestamp>_<uuid>.jsonl, and nothing exists before the first reply completes', () => {
    const f = fixture('plain')
    const [file] = Object.keys(f.files)
    expect(file).toMatch(new RegExp(`_${f.sessionIdLaunched}\\.jsonl$`))
    expect(f.files[file!]![0]!.id).toBe(f.sessionIdLaunched)
    const start = events(f, 'session_start')[0]!
    expect(start.fileBytes).toBe(-1)
    // The assistant's own message_end still sees no file: the whole session
    // is written at once, after it.
    const assistantEnd = events(f, 'message_end').find(e => (e.message as { role?: string }).role === 'assistant')!
    expect(assistantEnd.fileBytes).toBe(-1)
  })

  it('H2: the file pi names at session_start is the file it later writes — for startup, /new, fork and resume', () => {
    for (const name of ['plain', 'new-session', 'fork', 'resume']) {
      const f = fixture(name)
      for (const start of events(f, 'session_start')) {
        expect(Object.keys(f.files)).toContain(start.sessionFile)
        expect(f.files[start.sessionFile!]![0]!.id).toBe(start.sessionId)
      }
    }
  })

  it('H3: turn_end is a doorbell — its messageEntryId and toolResultEntryIds are on disk when the handler runs', () => {
    let checked = 0
    for (const f of fixtures.values()) {
      for (const turnEnd of events(f, 'turn_end')) {
        if ((turnEnd.fileBytes ?? -1) < 0) continue
        const onDisk = idsOnDisk(f, turnEnd.sessionFile!, turnEnd.fileBytes!)
        expect(onDisk.has(turnEnd.messageEntryId as string)).toBe(true)
        for (const id of (turnEnd.toolResultEntryIds as string[]) ?? []) expect(onDisk.has(id)).toBe(true)
        checked += 1
      }
    }
    expect(checked).toBeGreaterThan(30)
  })

  it('H3: agent_settled is a doorbell for everything the run wrote', () => {
    for (const f of fixtures.values()) {
      for (const settled of events(f, 'agent_settled')) {
        if ((settled.fileBytes ?? -1) < 0) continue
        const onDisk = idsOnDisk(f, settled.sessionFile!, settled.fileBytes!)
        // Everything up to and including the leaf pi reports is on disk.
        expect(onDisk.has(settled.leafId as string)).toBe(true)
      }
    }
  })

  it('H4: one agent_start → agent_settled span per run; queued steer/follow-up prompts run inside the same span', () => {
    for (const f of fixtures.values()) {
      const sequence = f.events.filter(e => e.name === 'agent_start' || e.name === 'agent_settled').map(e => e.name)
      // Strict alternation: no nested runs, no settle without a start. A
      // killed process may leave the last run open.
      const expected = sequence.map((_, index) => (index % 2 === 0 ? 'agent_start' : 'agent_settled'))
      expect(sequence).toEqual(expected)
    }
    const queued = fixture('queued')
    const slowRun = queued.events.filter(e => e.name === 'agent_start')[1]!
    const settleAfter = queued.events.find(e => e.name === 'agent_settled' && e.t > slowRun.t)!
    const assistantEndsInRun = queued.events.filter(
      e => e.name === 'message_end' && (e.message as { role?: string }).role === 'assistant' && e.t > slowRun.t && e.t <= settleAfter.t,
    )
    expect(assistantEndsInRun).toHaveLength(3) // slow reply, steer reply, follow-up reply
  })

  it('H5: a prompt sent through the extension while busy WITHOUT a delivery mode is accepted by the API and silently lost', () => {
    const f = fixture('socket')
    const texts = Object.values(f.files).flat().map(userText)
    expect(texts.some(text => text.includes('[probe:s-none]'))).toBe(false)
    expect(texts.some(text => text.includes('[probe:s-follow]'))).toBe(true)
    expect(texts.some(text => text.includes('[probe:s-steer]'))).toBe(true)
    // ...even though pi fired `input` for it and sendUserMessage returned:
    // neither can serve as a delivery acknowledgement.
    expect(f.events.some(e => e.name === 'input' && e.probeTag === '[probe:s-none]')).toBe(true)
    expect(f.events.some(e => e.name === 'probe_command_ok' && e.tag === 'c8')).toBe(true)
  })

  it('H5: deliverAs followUp while idle is ignored by pi and starts a normal run', () => {
    const f = fixture('socket-idle-followup')
    expect(Object.values(f.files).flat().map(userText).some(text => text.includes('[probe:s-idle-follow]'))).toBe(true)
    expect(events(f, 'agent_settled')).toHaveLength(1)
  })

  it('H6: a /tree move without a summary writes nothing — the last row is NOT the live leaf until the next append', () => {
    const f = fixture('tree')
    const move = events(f, 'session_tree')[0]!
    const [file] = Object.keys(f.files)
    const onDisk = f.files[file!]!.filter((row, index) => rowEnds(f, file!)[index]! <= move.fileBytes!)
    expect(onDisk.at(-1)!.id).not.toBe(move.newLeafId)
    expect(onDisk.some(row => row.id === move.newLeafId)).toBe(true)
    // With a summary, the branch_summary row IS the new leaf and is written.
    const summarized = events(f, 'session_tree')[1]!
    expect((summarized.summaryEntry as { type?: string }).type).toBe('branch_summary')
    // The final active branch excludes the abandoned turns.
    const branch = referenceActiveBranch(f.files[file!]!)
    const abandoned = f.files[file!]!.filter(isEntry).filter(row => !branch.some(b => b.id === row.id))
    expect(abandoned.length).toBeGreaterThan(0)
    expect(roles(branch).at(-1)).toBe('assistant')
  })

  it('H7: the trust prompt is visible to -e extensions before session_start, and is not an extension ui_prompt', () => {
    const f = fixture('trust')
    const trust = events(f, 'project_trust')[0]!
    const start = events(f, 'session_start')[0]!
    expect(trust.t).toBeLessThan(start.t)
    expect(events(f, 'ui_prompt_start')).toHaveLength(0)
  })

  it('H8: an xterm.js terminal answers the startup queries (no hand-answered DA1)', () => {
    for (const f of fixtures.values()) {
      expect(f.meta.terminal).toBe('@xterm/headless')
      expect(f.pty.da1HandAnswered).toBe(0)
    }
  })

  it('extension dialogs raise ui_prompt_start / ui_prompt_end around the blocking wait', () => {
    const f = fixture('dialog')
    expect(events(f, 'ui_prompt_start')[0]).toMatchObject({ kind: 'confirm', title: 'Probe dialog' })
    expect(events(f, 'ui_prompt_end')[0]!.t).toBeGreaterThan(events(f, 'ui_prompt_start')[0]!.t)
  })

  it('a process killed mid-stream leaves the user row and no partial assistant row', () => {
    const f = fixture('kill')
    const rows = Object.values(f.files)[0]!
    expect(roles(referenceActiveBranch(rows)).at(-1)).toBe('user')
  })

  it('fork copies the ancestor entries WITH their ids into a new file whose header names the parent', () => {
    const f = fixture('fork')
    const [parentFile, childFile] = Object.keys(f.files).sort()
    const child = f.files[childFile!]!
    expect(child[0]!.parentSession).toBe(parentFile)
    const parentIds = new Set(f.files[parentFile!]!.filter(isEntry).map(row => row.id))
    expect(child.filter(isEntry).filter(row => parentIds.has(row.id)).length).toBeGreaterThan(3)
  })
})
