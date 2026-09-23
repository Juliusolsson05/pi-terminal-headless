// THE isolated layer where Pi's two sources meet: the durable session file
// (what was said) and the bridge (when, and which session/branch is live).
//
// Its single consumer is PiTerminalHeadless. Nothing else in the package —
// and nothing in Agent Code — may import it. It sees rows and live outputs,
// never sockets or files, so every ordering rule below is tested over the
// Stage 0 recordings' own interleavings (reconcile/SessionSequencer.test.ts).
//
// The rules (spec §5.4), and why each exists:
//
//  1. ANSWER BEFORE END. A turn's `turn_completed` is released only after the
//     rows the bridge named for it are committed (turn_end's messageEntryId +
//     toolResultEntryIds, agent_settled's leaf), or after a bounded settle
//     deadline. Agent Code's renderer, orchestration_wait_agents and
//     Copy Last Response all read the conversation the moment a turn ends; a
//     turn end that beats its own answer reads the previous answer. Every
//     live output after a held turn end waits behind it, so "idle" can never
//     overtake the answer either. (The OpenCode Terminal rule, same 2 s.)
//  2. ONE RUN = ONE TURN — decided upstream by LiveStateProjector (H4).
//  3. ACTIVE BRANCH ONLY. Rows are emitted only while they are on the branch
//     Pi is on. A branch change (a /tree move, or the first row after one)
//     is a history `reset` followed by the new branch and `caught-up` — the
//     Grok history-boundary contract both of Agent Code's SessionFeeds carry.
//     A /tree move without a summary writes no row (H6), so the live leaf
//     comes from the bridge until a row lands on it.
//  4. SESSION SWITCH = identity change + reset. /new, /resume, /fork, /clone
//     retarget the reader; the new file may not exist yet (a fresh /new).
//  5. FOREIGN ROWS NEVER LEAK: rows from any file but the current one are
//     dropped, even when an old read finishes late.
//  6. EXIT ENDS EVERYTHING: final drain, open turn ended, dialogs cleared.
//  7. REWRITES RESET: a replaced or shrunk file restarts the branch.
//
// Attaching to a session that already has history (a restart/resume): the
// host loads that history itself (cold read, history.ts), so the rows present
// at the first read are marked known, not re-emitted.

import { BranchCursor, TreeIndex, type BranchChange } from '../transcript/ActiveBranch.js'
import { isMessageRow, type PiSessionRow } from '../transcript/SessionFile.js'
import type { SemanticEvent } from '../channels/types.js'
import type { LiveOutput, PendingDialog } from '../live/types.js'

export type SequencerSink = {
  entry(row: PiSessionRow, file: string): void
  history(kind: 'reset' | 'caught-up', file: string): void
  semantic(event: SemanticEvent): void
  activity(activity: { active: boolean | null; status: string }): void
  dialogs(dialog: PendingDialog | null, trustPending: boolean): void
  sessionSwitched(from: { sessionId: string; file: string | null }, to: { sessionId: string; file: string }, reason: string): void
  /** Follow this file from now on (create or retarget the durable reader). */
  retarget(file: string): void
  /** Read the current file now; resolves when that read is done. */
  ring(): Promise<void>
  error(code: string, message: string): void
}

export type SequencerOptions = {
  now?: () => number
  settleDeadlineMs?: number
  settlePollMs?: number
}

type HeldTurnEnd = { turnId: string; waitFor: Set<string>; deadline: number }

export class SessionSequencer {
  private file: string | null
  private sessionId: string
  private index = new TreeIndex()
  private cursor = new BranchCursor()
  /**
   * The live /tree leaf, when it differs from the last row. `null` is a real
   * value: moving to before the first entry leaves Pi with an EMPTY branch
   * (agent-session.js navigates to the root message's parentId, null, then
   * resetLeaf()). `undefined` means "no override: use the last row".
   */
  private leafOverride: string | null | undefined
  /**
   * What Pi was on when the live leaf last moved: its old leaf and the branch
   * we were showing. Evidence for telling rows written BEFORE the move (read
   * late — the durable reader polls) from rows that continue the new branch.
   */
  private navigation: { oldLeafId: string | null | undefined; oldBranch: Set<string> } | undefined
  /** Seed (don't emit) the first read of the file we attached to. */
  private seedNextRead: boolean
  private turnId: string | null = null
  private turnDoorbellIds = new Set<string>()
  private held: HeldTurnEnd | undefined
  private queue: LiveOutput[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private readonly now: () => number
  private readonly settleDeadlineMs: number
  private readonly settlePollMs: number

  constructor(
    private readonly sink: SequencerSink,
    initial: { sessionId: string; file: string | null; attachExisting: boolean },
    options: SequencerOptions = {},
  ) {
    this.sessionId = initial.sessionId
    this.file = initial.file
    this.seedNextRead = initial.attachExisting
    this.now = options.now ?? Date.now
    this.settleDeadlineMs = options.settleDeadlineMs ?? 2_000
    this.settlePollMs = options.settlePollMs ?? 25
  }

  currentFile(): string | null {
    return this.file
  }

  currentSessionId(): string {
    return this.sessionId
  }

  /**
   * The file of the session we launched became known without a switch: the
   * bridge's first session_start, or the host's directory scan when no bridge
   * connected. Not a switch — same session id.
   */
  discoveredFile(file: string): void {
    if (this.disposed || this.file === file) return
    this.file = file
    this.sink.retarget(file)
  }

  onDurableRows(rows: PiSessionRow[], file: string): void {
    if (this.disposed || file !== this.file) return // rule 5
    for (const row of rows) this.index.add(row)
    // A /tree override holds only until a row Pi wrote AFTER the move lands
    // on its branch (H6); see rowsContinueNavigation.
    if (this.leafOverride !== undefined && rows.length > 0 && this.rowsContinueNavigation()) {
      this.leafOverride = undefined
      this.navigation = undefined
    }
    if (this.seedNextRead) {
      this.seedNextRead = false
      this.cursor.seed(this.currentBranch().map(row => row.id))
      return
    }
    this.emitBranchChange()
    this.checkHeld()
  }

  onDurableReset(file: string): void {
    if (this.disposed || file !== this.file) return
    // Rule 7: the old tree is void. The cursor forces the next branch out as
    // a reset, so the consumer replaces what it had.
    this.index = new TreeIndex()
    this.leafOverride = undefined
    this.navigation = undefined
    this.cursor.clear()
    this.seedNextRead = false
  }

  onLive(outputs: LiveOutput[]): void {
    if (this.disposed) return
    this.queue.push(...outputs)
    this.drainQueue()
  }

  /**
   * pi exited. `closing` are the projector's endForExit outputs. The final
   * drain gives the file its last rows before the turn is ended, then `done`.
   */
  onExit(closing: LiveOutput[], done: () => void): void {
    if (this.disposed) {
      done()
      return
    }
    void this.sink.ring().catch(() => undefined).finally(() => {
      // No live channel can ring any more: release a held turn now rather
      // than waiting out its deadline on a dead process.
      if (this.held) this.releaseHeld('exit')
      this.queue.push(...closing)
      this.drainQueue()
      if (this.held) this.releaseHeld('exit')
      done()
    })
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.queue = []
    this.held = undefined
  }

  // ---------------------------------------------------------------------------

  private currentBranch(): PiSessionRow[] {
    return this.index.branch(this.leafOverride)
  }

  /**
   * Does the newest row continue the branch Pi moved to, so the override can
   * go? It must be ON that branch AND written after the move.
   *
   * WHY "on the branch" alone is wrong (Astra review, finding 8): the reader
   * polls, so a row Pi wrote just BEFORE the move can be read just after it.
   * Idle `/name` writes a metadata row `d` under leaf `c`; `/tree` then moves
   * to `a` (no summary, no row). When `d` is read, its chain a→b→c→d does
   * contain `a`, and the old rule dropped the override and resurrected the
   * abandoned turns b, c. Pi itself is on `a` and its next row is a child of
   * `a` (or, after a move to the root, a new root).
   *
   * The test: take the row just BELOW the override on the newest row's chain
   * (after a move to the root: the chain's own root). A row written before
   * the move reaches the override through the OLD branch, so that row is
   * either on the branch we showed at the move, or on the old leaf's path
   * (Pi appends in order, so once the old leaf is read its whole path is).
   * A row written after the move reaches it through a new child.
   *
   * Not covered: several rows written before the move, NONE of them read at
   * the move, and the old leaf not read yet — they look new, which is the
   * old behaviour. It needs a poll gap spanning a burst of writes and a /tree
   * picker interaction; the next row Pi writes corrects the view.
   */
  private rowsContinueNavigation(): boolean {
    const chain = this.index.branch()
    let below: PiSessionRow | undefined
    if (this.leafOverride === null) {
      below = chain[0]
    } else {
      const at = chain.findIndex(row => row.id === this.leafOverride)
      if (at < 0) return false
      below = chain[at + 1]
      // The override row itself arrived last: the branches are identical.
      if (!below) return true
    }
    if (!below) return false
    const navigation = this.navigation
    if (!navigation) return true
    if (navigation.oldBranch.has(below.id)) return false
    const oldLeaf = navigation.oldLeafId
    if (oldLeaf && this.index.has(oldLeaf) && this.index.branch(oldLeaf).some(row => row.id === below.id)) return false
    return true
  }

  private emitBranchChange(): void {
    if (!this.file) return
    const change: BranchChange | null = this.cursor.next(this.currentBranch())
    if (!change) return
    const file = this.file
    if (change.kind === 'reset') this.safe(() => this.sink.history('reset', file))
    for (const row of change.rows) this.safe(() => this.sink.entry(row, file))
    if (change.kind === 'reset') this.safe(() => this.sink.history('caught-up', file))
  }

  private drainQueue(): void {
    while (!this.held && this.queue.length && !this.disposed) {
      this.apply(this.queue.shift()!)
    }
  }

  private apply(output: LiveOutput): void {
    switch (output.kind) {
      case 'turn-start':
        this.turnId = output.turnId
        this.turnDoorbellIds = new Set()
        this.semantic({ type: 'turn_started', turnId: output.turnId, role: 'assistant', source: 'pi-bridge', confidence: 'high', ts: this.now() })
        break
      case 'turn-end': {
        const waitFor = new Set(this.turnDoorbellIds)
        if (output.leafId) waitFor.add(output.leafId)
        this.held = { turnId: output.turnId, waitFor, deadline: this.now() + this.settleDeadlineMs }
        this.checkHeld()
        break
      }
      case 'doorbell':
        for (const id of output.entryIds) if (this.turnId) this.turnDoorbellIds.add(id)
        void this.sink.ring().catch(() => undefined)
        break
      case 'activity':
        this.safe(() => this.sink.activity({ active: output.active, status: output.status }))
        break
      case 'phase':
        this.semantic({ type: 'stream_phase', turnId: output.turnId, phase: output.phase, ...(output.toolName ? { toolName: output.toolName } : {}), source: 'pi-bridge', ts: this.now() })
        break
      case 'api-error':
        this.semantic({ type: 'api_error', turnId: output.turnId, message: output.message, errorType: output.errorType, source: 'pi-bridge', ts: this.now() })
        break
      case 'dialogs':
        this.safe(() => this.sink.dialogs(output.dialog, output.trustPending))
        break
      case 'leaf':
        // Snapshot BEFORE moving: the branch shown now is Pi's old branch.
        this.navigation = { oldLeafId: output.oldLeafId, oldBranch: new Set(this.currentBranch().map(row => row.id)) }
        this.leafOverride = output.leafId
        this.emitBranchChange()
        break
      case 'session':
        this.switchSession(output)
        break
    }
  }

  private switchSession(output: Extract<LiveOutput, { kind: 'session' }>): void {
    if (output.file === this.file) {
      // Same file (startup, or a relaunch of the same session): identity only.
      this.sessionId = output.sessionId || this.sessionId
      return
    }
    if (this.file === null && output.sessionId === this.sessionId) {
      // The launched session announcing its (not yet written) file.
      this.discoveredFile(output.file)
      return
    }
    const from = { sessionId: this.sessionId, file: this.file }
    this.file = output.file
    this.sessionId = output.sessionId
    this.index = new TreeIndex()
    this.cursor.seed([]) // rows of the new file are appended after the reset below
    this.leafOverride = undefined
    this.navigation = undefined
    this.seedNextRead = false
    this.safe(() => this.sink.sessionSwitched(from, { sessionId: output.sessionId, file: output.file }, output.reason))
    const file = output.file
    this.safe(() => this.sink.history('reset', file))
    this.safe(() => this.sink.retarget(file))
    // caught-up after the first read of the new file (it may not exist yet:
    // a fresh /new writes nothing until its first reply completes).
    void this.sink.ring().catch(() => undefined).finally(() => {
      if (!this.disposed && this.file === file) this.safe(() => this.sink.history('caught-up', file))
    })
  }

  private checkHeld(): void {
    const held = this.held
    if (!held) return
    const missing = [...held.waitFor].filter(id => !this.index.has(id))
    if (missing.length === 0 || !this.file) {
      this.releaseHeld('committed')
      return
    }
    if (this.now() >= held.deadline) {
      this.safe(() => this.sink.error('settle_deadline', `turn ${held.turnId} ended before ${missing.length} of its rows were readable`))
      this.releaseHeld('deadline')
      return
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        void this.sink.ring().catch(() => undefined).finally(() => this.checkHeld())
      }, this.settlePollMs)
      this.timer.unref?.()
    }
  }

  private releaseHeld(_why: 'committed' | 'deadline' | 'exit'): void {
    const held = this.held
    if (!held) return
    this.held = undefined
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.semantic({ type: 'turn_completed', turnId: held.turnId, fullText: this.lastAssistantText(), source: 'pi-bridge', confidence: 'high', ts: this.now() })
    if (this.turnId === held.turnId) this.turnId = null
    this.drainQueue()
  }

  /** Text of the last assistant message on the live branch (what the turn answered). */
  private lastAssistantText(): string {
    const branch = this.currentBranch()
    for (let i = branch.length - 1; i >= 0; i -= 1) {
      const row = branch[i]!
      if (!isMessageRow(row) || row.message.role !== 'assistant') continue
      const content = row.message.content
      if (typeof content === 'string') return content
      if (!Array.isArray(content)) return ''
      return content
        .filter(block => block && typeof block === 'object' && (block as { type?: unknown }).type === 'text')
        .map(block => String((block as { text?: unknown }).text ?? ''))
        .join('')
    }
    return ''
  }

  private semantic(event: SemanticEvent): void {
    this.safe(() => this.sink.semantic(event))
  }

  // A throwing sink must not wedge the sequencer (a held turn would never
  // release); it is reported and sequencing continues.
  private safe(fn: () => void): void {
    try {
      fn()
    } catch (error) {
      try {
        this.sink.error('sink_failed', (error as Error)?.message ?? String(error))
      } catch {
        // nothing left to tell
      }
    }
  }
}
