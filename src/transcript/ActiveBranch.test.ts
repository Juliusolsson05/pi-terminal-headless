import { describe, expect, it } from 'vitest'

import { listLiveFixtures, loadLiveFixture, toJsonl } from '../testing/fixtures.js'
import { referenceActiveBranch } from '../testing/oracle.js'
import { BranchCursor, TreeIndex } from './ActiveBranch.js'
import { parseSessionText, type PiSessionRow } from './SessionFile.js'

function indexOf(rows: PiSessionRow[]): TreeIndex {
  const index = new TreeIndex()
  for (const row of rows) index.add(row)
  return index
}

describe('TreeIndex.branch', () => {
  it('agrees with the independent reference walk on every recorded file', () => {
    let files = 0
    for (const name of listLiveFixtures()) {
      for (const rows of Object.values(loadLiveFixture(name).files)) {
        const parsed = parseSessionText(toJsonl(rows)).rows
        expect(indexOf(parsed).branch().map(row => row.id)).toEqual(referenceActiveBranch(rows).map(row => row.id))
        files += 1
      }
    }
    expect(files).toBeGreaterThan(15)
  })

  it('excludes the turns a /tree move abandoned (the tree recording)', () => {
    const [rows] = Object.values(loadLiveFixture('tree').files)
    const parsed = parseSessionText(toJsonl(rows!)).rows
    const branch = indexOf(parsed).branch()
    const texts = branch.flatMap(row => {
      const content = (row.message as { content?: Array<{ text?: string }> } | undefined)?.content
      return Array.isArray(content) ? content.map(block => block.text ?? '') : []
    })
    expect(texts.some(text => text.includes('[probe:t2]'))).toBe(false)
    expect(texts.some(text => text.includes('[probe:t3]'))).toBe(false)
    expect(texts.some(text => text.includes('[probe:t4]'))).toBe(true)
  })

  it('an explicit leaf that has not been read yet is an empty branch, not a crash', () => {
    expect(new TreeIndex().branch('nope')).toEqual([])
  })

  it('a malformed cycle terminates', () => {
    const index = new TreeIndex()
    index.add({ type: 'x', id: 'a', parentId: 'b', line: 1 })
    index.add({ type: 'x', id: 'b', parentId: 'a', line: 2 })
    expect(index.branch().map(row => row.id)).toEqual(['a', 'b'])
  })
})

describe('BranchCursor over the live tree recording', () => {
  // Replays the tree scenario the way the sequencer will: rows arrive in file
  // order, and each session_tree event overrides the leaf until the next row
  // is appended (H6: a move without summary writes nothing).
  it('appends along one branch, resets on a tree move, then appends on the new branch', () => {
    const fixture = loadLiveFixture('tree')
    const [file, rows] = Object.entries(fixture.files)[0]!
    const parsed = parseSessionText(toJsonl(rows)).rows
    const moves = fixture.events.filter(event => event.name === 'session_tree')
    const index = new TreeIndex()
    const cursor = new BranchCursor()
    const changes: Array<{ kind: string; ids: string[] }> = []
    const rowEnds: number[] = []
    let offset = 0
    for (const length of fixture.fileRowBytes[file]!) rowEnds.push((offset += length))

    let moveIndex = 0
    parsed.forEach(row => {
      // Apply every tree move that happened before this row reached disk.
      while (moveIndex < moves.length && moves[moveIndex]!.fileBytes! < rowEnds[row.line]!) {
        const change = cursor.next(index.branch(moves[moveIndex]!.newLeafId as string))
        if (change) changes.push({ kind: change.kind, ids: change.rows.map(r => r.id) })
        moveIndex += 1
      }
      index.add(row)
      const change = cursor.next(index.branch())
      if (change) changes.push({ kind: change.kind, ids: change.rows.map(r => r.id) })
    })

    const kinds = changes.map(change => change.kind)
    // Two moves in the recording, each seen as exactly one reset.
    expect(kinds.filter(kind => kind === 'reset')).toHaveLength(2)
    // After every reset, the next change is an append (the new turn lands on the new branch).
    kinds.forEach((kind, i) => {
      if (kind === 'reset' && i + 1 < kinds.length) expect(kinds[i + 1]).toBe('append')
    })
    // The consumer's final view equals the branch Pi would load.
    const view: string[] = []
    for (const change of changes) {
      if (change.kind === 'reset') view.length = 0
      view.push(...change.ids)
    }
    expect(view).toEqual(referenceActiveBranch(rows).map(row => row.id))
  })

  it('clear() forces the next branch to be a reset even when it is a prefix-extension', () => {
    const cursor = new BranchCursor()
    const a = { type: 'x', id: 'a', parentId: null, line: 1 }
    expect(cursor.next([a])?.kind).toBe('append')
    cursor.clear()
    expect(cursor.next([a])).toEqual({ kind: 'reset', rows: [a] })
  })

  it('seed() treats known history as emitted, so only new rows follow', () => {
    const cursor = new BranchCursor()
    const a = { type: 'x', id: 'a', parentId: null, line: 1 }
    const b = { type: 'x', id: 'b', parentId: 'a', line: 2 }
    cursor.seed(['a'])
    expect(cursor.next([a, b])).toEqual({ kind: 'append', rows: [b] })
  })
})
