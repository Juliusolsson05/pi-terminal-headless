import { describe, expect, it } from 'vitest'

import type { PiSessionRow } from '../transcript/SessionFile.js'
import { SessionSequencer, type SequencerSink } from './SessionSequencer.js'

// The sequencer's /tree contract in isolation (the replay tests cover it over
// recordings). A move to BEFORE the first entry is a real Pi state: its tree
// navigation sets the leaf to the root message's parentId, null, and Pi's
// active branch is then empty until the next row lands.

function recordingSink() {
  const log: string[] = []
  const sink: SequencerSink = {
    entry: row => log.push(`entry:${row.id}`),
    history: kind => log.push(`history:${kind}`),
    semantic: () => undefined,
    activity: () => undefined,
    dialogs: () => undefined,
    sessionSwitched: () => undefined,
    retarget: () => undefined,
    ring: async () => undefined,
    error: (code, message) => log.push(`error:${code}:${message}`),
  }
  return { sink, log }
}

const row = (id: string, parentId: string | null, line: number): PiSessionRow => ({ type: 'message', id, parentId, line, message: { role: 'user', content: [] } })

describe('SessionSequencer /tree leaf', () => {
  it('a move to the root (null leaf) empties the branch; the next row starts the new one', () => {
    const { sink, log } = recordingSink()
    const sequencer = new SessionSequencer(sink, { sessionId: 's', file: '/f.jsonl', attachExisting: false })
    sequencer.onDurableRows([row('a', null, 1), row('b', 'a', 2)], '/f.jsonl')
    log.length = 0
    sequencer.onLive([{ kind: 'leaf', leafId: null }])
    // The consumer drops the abandoned conversation instead of keeping it.
    expect(log).toEqual(['history:reset', 'history:caught-up'])
    log.length = 0
    sequencer.onDurableRows([row('c', null, 3)], '/f.jsonl')
    expect(log.filter(line => line.startsWith('entry:'))).toEqual(['entry:c'])
    sequencer.dispose()
  })
})
