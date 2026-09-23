// Tails ONE Pi session file and delivers its complete rows in file order.
//
// It knows bytes and lines, not branches or turns: `SessionFile` owns the
// schema, `ActiveBranch` owns the tree, the sequencer owns ordering against
// the live channel. This split is what lets the reader be tested with nothing
// but a temp file and a recording's byte-growth series.
//
// Shape of the problem (research/census-2026-09-22.md):
//   - A fresh session's file DOES NOT EXIST until the first reply completes;
//     then everything so far appears at once. Absence is a normal state.
//   - Afterwards Pi appends one row per synchronous appendFileSync, but the
//     reader can still observe a partial last line (it reads while Pi writes a
//     large row), so only newline-terminated lines are committed.
//   - Pi REWRITES the file in place when it loads an old-version file
//     (migrateToCurrentVersion), and a user can replace it. Offsets belong to
//     one version of the file, so a change of inode, a shrink, or a changed
//     header line is a reset. The header check exists because Pi's rewrite does
//     NOT change the inode: session-manager.js `_rewriteFile` does
//     `openSync(file, "w")` on the same path, and a v1→v3 migration adds
//     ids, so the file GROWS. Without the check, the next read would resume
//     mid-line at the old offset and chain the migrated rows onto the old ones.
//     Every rewrite writes a new header line (migration adds `version`), so
//     comparing line 0's bytes is enough.
//
// Wake-up policy (spec §4): `ring()` reads immediately — the bridge calls it
// on `turn_end` / `agent_settled` / `session_tree` / `session_compact` /
// `session_start`, whose rows are on disk when they fire (H3). The poll timer
// is the safety net: fast (100 ms) while no live channel is connected, slow
// while one is, because then every row that matters is announced.
//
// Reads are asynchronous and serialized: a resumed session can be megabytes
// (Pi's own test fixture is 2.3 MB) and this runs in Agent Code's main
// process, where a synchronous multi-megabyte read + parse would stall every
// window. At most one read is in flight; rings during a read coalesce into
// one follow-up read.

import { open, stat } from 'node:fs/promises'

import { parseLine, SessionFileError, SessionRowNormalizer, type PiSessionHeader, type PiSessionRow } from './SessionFile.js'

export type DurableReaderEvents = {
  /** Complete rows read in this pass, in file order. */
  onRows(rows: PiSessionRow[], generation: number): void
  /** The header, once per generation (line 0). */
  onHeader?(header: PiSessionHeader, generation: number): void
  /** The file was replaced or shrank: everything read before is void. */
  onReset?(reason: 'replaced' | 'truncated', generation: number): void
  /** A line that is not a JSON object, or an I/O failure. Never fatal. */
  onError?(error: Error): void
}

export type DurableReaderOptions = {
  fastPollMs?: number
  slowPollMs?: number
}

export class DurableReader {
  private file: string
  private generation = 0
  private offset = 0
  private identity: string | null = null
  /** Line 0's exact bytes plus its newline, once read; see the header comment. */
  private headerBytes: Buffer | null = null
  private line = 0
  private partial = Buffer.alloc(0)
  private normalizer = new SessionRowNormalizer()
  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight: Promise<void> | null = null
  private again = false
  private stopped = false
  private pollMs: number
  private readonly fastPollMs: number
  private readonly slowPollMs: number

  constructor(file: string, private readonly events: DurableReaderEvents, options: DurableReaderOptions = {}) {
    this.file = file
    this.fastPollMs = options.fastPollMs ?? 100
    this.slowPollMs = options.slowPollMs ?? 1000
    this.pollMs = this.fastPollMs
  }

  getFile(): string {
    return this.file
  }

  start(): void {
    if (this.stopped || this.timer) return
    this.armTimer()
    void this.ring()
  }

  /**
   * Live channel connected ⇒ slow safety poll; disconnected ⇒ fast poll.
   * WHY keep polling at all while connected: a doorbell can be missed (socket
   * drop between event and delivery), and a stale transcript is the failure
   * the whole package exists to prevent.
   */
  setLiveConnected(connected: boolean): void {
    const next = connected ? this.slowPollMs : this.fastPollMs
    if (next === this.pollMs) return
    this.pollMs = next
    if (this.timer) this.armTimer()
  }

  /**
   * Follow a different file (session switch). Everything known about the old
   * file is dropped; the new file may not exist yet (a fresh `/new` session).
   */
  retarget(file: string): void {
    this.file = file
    this.resetState()
    void this.ring()
  }

  /** Read whatever is new now. Resolves when this read (or the one it joined) is done. */
  ring(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.inFlight) {
      this.again = true
      return this.inFlight
    }
    this.inFlight = this.readLoop().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  /** Stop scheduling, finish any read in flight, then read once more (for process exit). */
  async drain(): Promise<void> {
    this.clearTimer()
    await this.inFlight
    if (this.stopped) return
    await this.ring()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.clearTimer()
    await this.inFlight
  }

  private armTimer(): void {
    this.clearTimer()
    this.timer = setInterval(() => void this.ring(), this.pollMs)
    // A tailer must never keep Agent Code (or a test runner) alive by itself.
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private resetState(): void {
    this.generation += 1
    this.offset = 0
    this.identity = null
    this.headerBytes = null
    this.line = 0
    this.partial = Buffer.alloc(0)
    this.normalizer = new SessionRowNormalizer()
  }

  private async readLoop(): Promise<void> {
    do {
      this.again = false
      await this.readOnce()
    } while (this.again && !this.stopped)
  }

  private async readOnce(): Promise<void> {
    const file = this.file
    let handle
    try {
      handle = await open(file, 'r')
    } catch (error) {
      // ENOENT is the normal "no reply has completed yet" state (H1).
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.report(error as Error)
      return
    }
    try {
      const info = await handle.stat()
      // A retarget while we were opening: this handle belongs to the old file.
      if (file !== this.file || this.stopped) return
      const identity = `${info.dev}:${info.ino}`
      let rewritten = false
      if (this.identity === identity && this.headerBytes && info.size >= this.headerBytes.length) {
        const current = Buffer.alloc(this.headerBytes.length)
        await handle.read(current, 0, current.length, 0)
        rewritten = !current.equals(this.headerBytes)
      }
      if (this.identity !== null && (identity !== this.identity || info.size < this.offset || rewritten)) {
        const reason = identity !== this.identity || rewritten ? 'replaced' : 'truncated'
        this.resetState()
        this.safe(() => this.events.onReset?.(reason, this.generation))
      }
      this.identity = identity
      if (info.size <= this.offset) return
      const length = info.size - this.offset
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, this.offset)
      if (file !== this.file || this.stopped) return
      this.offset += bytesRead
      this.consume(buffer.subarray(0, bytesRead))
    } catch (error) {
      this.report(error as Error)
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  private consume(chunk: Buffer): void {
    // Raw bytes, not text, are buffered across reads: a read can end inside a
    // multi-byte UTF-8 character, and decoding each read separately would
    // corrupt it. A newline byte never occurs inside a multi-byte sequence.
    const combined = this.partial.length ? Buffer.concat([this.partial, chunk]) : chunk
    const rows: PiSessionRow[] = []
    let cursor = 0
    for (;;) {
      const newline = combined.indexOf(0x0a, cursor)
      if (newline === -1) break
      if (this.line === 0) this.headerBytes = Buffer.from(combined.subarray(cursor, newline + 1))
      const text = combined.subarray(cursor, newline).toString('utf8')
      const line = this.line
      this.line += 1
      cursor = newline + 1
      if (!text.trim()) continue
      try {
        const result = this.normalizer.push(parseLine(text, line), line)
        if ('header' in result) this.safe(() => this.events.onHeader?.(result.header, this.generation))
        else rows.push(result.row)
      } catch (error) {
        if (error instanceof SessionFileError) this.report(error)
        else throw error
      }
    }
    this.partial = Buffer.from(combined.subarray(cursor))
    if (rows.length) this.safe(() => this.events.onRows(rows, this.generation))
  }

  private report(error: Error): void {
    this.safe(() => this.events.onError?.(error))
  }

  // A throwing consumer must not wedge the reader (a stuck `inFlight` would
  // stop every later read); its failure is reported and reading continues.
  private safe(fn: () => void): void {
    try {
      fn()
    } catch (error) {
      try {
        this.events.onError?.(error as Error)
      } catch {
        // The error sink itself threw; nothing left to tell.
      }
    }
  }
}

/** Resolve whether a file currently exists (used by callers deciding what to wait for). */
export async function fileExists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}
