// Pure projection of Pi's entry tree onto the one branch the user is on.
//
// WHY this exists: Pi keeps every branch of a conversation in the same file
// (`/tree` moves the leaf; abandoned turns stay on disk). Agent Code's feed,
// its MCP transcript tools and provider switching all treat a transcript as a
// linear conversation, so anything that walks the file in line order would
// show abandoned turns as if they had happened (spec §5.4 rule 3).
//
// Semantics copied from Pi, not invented (SessionManager._buildIndex/getBranch
// in the pinned release, pinned by the corpus test H6):
//   - the branch is the parentId chain from a leaf back to a root;
//   - on LOAD the leaf is the last row in the file;
//   - LIVE, a /tree move without a summary changes the leaf without writing a
//     row, so the caller may pass an explicit leaf (from the bridge's
//     `session_tree.newLeafId`).
//
// No I/O here: the durable reader feeds rows in, the sequencer asks for the
// branch. That keeps every branch rule testable over recorded rows alone.

import type { PiSessionRow } from './SessionFile.js'

export class TreeIndex {
  private readonly byId = new Map<string, PiSessionRow>()
  private last: PiSessionRow | undefined

  add(row: PiSessionRow): void {
    // A duplicate id can only come from re-reading the same bytes (a caller
    // bug) or a rewrite we failed to notice; the newest copy wins so the
    // branch reflects what is on disk now.
    this.byId.set(row.id, row)
    this.last = row
  }

  get size(): number {
    return this.byId.size
  }

  get(id: string): PiSessionRow | undefined {
    return this.byId.get(id)
  }

  has(id: string): boolean {
    return this.byId.has(id)
  }

  /** The leaf Pi itself would load: the last row added. */
  lastRow(): PiSessionRow | undefined {
    return this.last
  }

  /**
   * The branch ending at `leafId` (default: the last row), oldest first.
   * A leaf that is not (yet) in the index yields the empty branch: the caller
   * asked for an entry whose row has not been read, which is a timing state,
   * not a conversation with no history — callers must treat it that way.
   */
  branch(leafId?: string | null): PiSessionRow[] {
    const leaf = leafId === undefined ? this.last : leafId === null ? undefined : this.byId.get(leafId)
    const out: PiSessionRow[] = []
    const seen = new Set<string>()
    let cursor = leaf
    while (cursor && !seen.has(cursor.id)) {
      // `seen` guards a malformed cycle: Pi never writes one (parents precede
      // children), but a hand-edited file must not hang the main process.
      seen.add(cursor.id)
      out.push(cursor)
      cursor = cursor.parentId ? this.byId.get(cursor.parentId) : undefined
    }
    return out.reverse()
  }
}

export type BranchChange =
  /** The new branch extends what was already emitted: emit only `rows`. */
  | { kind: 'append'; rows: PiSessionRow[] }
  /** The branch changed underneath (tree move, rewrite): replace everything with `rows`. */
  | { kind: 'reset'; rows: PiSessionRow[] }

/**
 * Tracks which branch rows have been emitted and turns a new branch into the
 * smallest change a consumer can apply.
 *
 * WHY a prefix test and not "rows added since last time": a new row can land
 * on a different branch (the first append after a /tree move), in which case
 * the consumer's list is wrong from the branch point on and must be replaced.
 * Replacing everything (reset) rather than splicing keeps the consumer
 * contract identical to the existing Grok history boundary: reset, then the
 * full branch, then caught-up.
 */
export class BranchCursor {
  private emitted: string[] = []
  private forceReset = false

  emittedIds(): readonly string[] {
    return this.emitted
  }

  next(branch: readonly PiSessionRow[]): BranchChange | null {
    const ids = branch.map(row => row.id)
    if (this.forceReset) {
      this.forceReset = false
      this.emitted = ids
      return { kind: 'reset', rows: [...branch] }
    }
    const isExtension = ids.length >= this.emitted.length && this.emitted.every((id, index) => ids[index] === id)
    if (isExtension) {
      if (ids.length === this.emitted.length) return null
      const rows = branch.slice(this.emitted.length)
      this.emitted = ids
      return { kind: 'append', rows }
    }
    this.emitted = ids
    return { kind: 'reset', rows: [...branch] }
  }

  /**
   * Forget everything (session switch, file rewrite): the next branch is
   * emitted as a reset even if it happens to be empty or share a prefix, so
   * the consumer drops the previous conversation instead of appending to it.
   */
  clear(): void {
    this.emitted = []
    this.forceReset = true
  }

  /**
   * Mark `ids` as already known to the consumer without emitting them — used
   * when attaching to an existing session whose history the host loads
   * separately (cold history), so the live tail starts after it.
   */
  seed(ids: readonly string[]): void {
    this.emitted = [...ids]
    this.forceReset = false
  }
}
