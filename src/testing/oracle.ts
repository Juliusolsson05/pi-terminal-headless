// Test oracle for the durable reader, derived from facts about a recording —
// never from the reader's own mechanism.
//
// WHY nothing here imports from src/transcript/: an oracle built with the
// reader's own helpers blesses the reader's bugs (the opencode-terminal-headless
// R3-F7 lesson). This walk is written from Pi's documented semantics
// (docs/session-format.md, SessionManager._buildIndex / getBranch in the
// pinned release):
//   - rows after the header link through `id` / `parentId`;
//   - on load, the leaf is the LAST row in the file;
//   - the active branch is the parentId chain from that leaf to a root.
// It is deliberately the naive O(n) version: easy to check by eye.

import type { RecordedRow } from './fixtures.js'

export function isEntry(row: RecordedRow): row is RecordedRow & { id: string } {
  return row.type !== 'session' && typeof row.id === 'string'
}

/** The active branch Pi itself would load from these rows, oldest first. */
export function referenceActiveBranch(rows: readonly RecordedRow[], leafId?: string | null): Array<RecordedRow & { id: string }> {
  const entries = rows.filter(isEntry)
  if (entries.length === 0) return []
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  const start = leafId === undefined ? entries[entries.length - 1] : leafId === null ? undefined : byId.get(leafId)
  const out: Array<RecordedRow & { id: string }> = []
  const seen = new Set<string>()
  let cursor = start
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    out.push(cursor)
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
  }
  return out.reverse()
}

/** Message roles along a branch, e.g. ['system','user','assistant']. */
export function roles(branch: ReadonlyArray<RecordedRow>): string[] {
  return branch.filter(row => row.type === 'message').map(row => String((row.message as { role?: unknown } | undefined)?.role))
}
