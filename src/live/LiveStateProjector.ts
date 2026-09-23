// Pure, synchronous: bridge events in, live-state transitions out.
//
// The only code that knows what Pi's extension events MEAN. It has no socket,
// no file and no clock of its own, so every rule below is tested by feeding
// it a recording's own event stream (live/LiveStateProjector.test.ts) and
// comparing against that recording's agent_start / agent_settled pairs.
//
// Rules, each from Stage 0 evidence (research/census-2026-09-22.md):
//  - A turn is one agent_start → agent_settled span (H4). agent_end is NOT the
//    end: an agent_end with willRetry is followed by more work, and queued
//    steer/follow-up prompts run inside the same span before agent_settled.
//    turn_start/turn_end inside a run are model steps, not user turns.
//  - Doorbells (H3) are turn_end (its messageEntryId + toolResultEntryIds),
//    agent_settled, session_tree, session_compact and session_start —
//    NEVER message_end, whose row is not on disk yet when it fires.
//  - A /tree move is a leaf change even when nothing is written (H6).
//  - A provider failure is a turn_end whose stopReason is 'error'; an Esc is
//    stopReason 'aborted' — reported as an api-error with errorType 'aborted'
//    so a consumer can tell them apart without parsing text.
//  - project_trust fires before session_start while Pi's trust selector is
//    up (H7); the prompt is pending until session_start.

import type { BridgeEvent } from '../bridge/protocol.js'
import type { LiveOutput, PendingDialog, StreamPhase } from './types.js'

const PHASES: Record<string, StreamPhase> = { thinking: 'thinking', responding: 'responding', tool: 'tool-use' }

export class LiveStateProjector {
  private turnSeq = 0
  private turnId: string | null = null
  private phase: StreamPhase = 'idle'
  private dialogs: PendingDialog[] = []
  private trustPending = false
  private sessionFile: string | null = null

  constructor(private readonly turnIdPrefix = 'pi-run') {}

  currentTurnId(): string | null {
    return this.turnId
  }

  apply(event: BridgeEvent): LiveOutput[] {
    const out: LiveOutput[] = []
    switch (event.name) {
      case 'project_trust':
        this.trustPending = true
        out.push(this.dialogOutput())
        break
      case 'session_start': {
        if (this.trustPending) {
          this.trustPending = false
          out.push(this.dialogOutput())
        }
        // A session replacement while a run was open cannot happen from the
        // TUI (the switch commands wait for idle), but a stale open turn must
        // never survive into the next session's accounting.
        if (this.turnId) out.push(...this.endTurn(null))
        if (event.file !== this.sessionFile) {
          this.sessionFile = event.file
          out.push({ kind: 'session', sessionId: event.sessionId, file: event.file, leafId: event.leafId, reason: event.reason })
        }
        out.push({ kind: 'doorbell', entryIds: [] })
        if (!this.turnId) out.push({ kind: 'activity', active: event.idle ? false : true, status: event.idle ? 'idle' : 'busy' })
        break
      }
      case 'agent_start':
        if (this.turnId) break // a second start inside a span would be a Pi bug; stay in the open turn
        this.turnSeq += 1
        this.turnId = `${this.turnIdPrefix}-${this.turnSeq}`
        out.push({ kind: 'turn-start', turnId: this.turnId }, { kind: 'activity', active: true, status: 'busy' })
        break
      case 'turn_end': {
        const ids = [...(event.messageEntryId ? [event.messageEntryId] : []), ...event.toolResultEntryIds]
        out.push({ kind: 'doorbell', entryIds: ids })
        if (event.stopReason === 'error' || event.stopReason === 'aborted') {
          out.push({
            kind: 'api-error',
            message: event.errorMessage ?? (event.stopReason === 'aborted' ? 'Operation aborted' : 'Provider error'),
            turnId: this.turnId,
            errorType: event.stopReason,
          })
        }
        break
      }
      case 'agent_settled':
        out.push({ kind: 'doorbell', entryIds: event.leafId ? [event.leafId] : [] })
        out.push(...this.endTurn(event.leafId))
        break
      case 'phase':
        out.push(...this.setPhase(PHASES[event.phase] ?? 'responding'))
        break
      case 'tool_execution_start':
        out.push(...this.setPhase('tool-use', event.toolName))
        break
      case 'compaction_start':
        out.push(...this.setPhase('compacting'))
        break
      case 'session_compact':
      case 'session_compact_failed':
        out.push({ kind: 'doorbell', entryIds: event.name === 'session_compact' && event.compactionEntryId ? [event.compactionEntryId] : [] })
        // Back to what the agent was doing: a manual /compact runs while idle.
        out.push(...this.setPhase(this.turnId ? 'responding' : 'idle'))
        break
      case 'session_tree':
        out.push({ kind: 'leaf', leafId: event.newLeafId, oldLeafId: event.oldLeafId }, { kind: 'doorbell', entryIds: event.summaryEntryId ? [event.summaryEntryId] : [] })
        break
      case 'ui_prompt_start':
        this.dialogs.push({ kind: event.kind, title: event.title ?? '' })
        out.push(this.dialogOutput())
        break
      case 'ui_prompt_end': {
        // Dialogs nest (an extension can open one from another's handler);
        // close the most recent matching one.
        const index = this.dialogs.map(d => `${d.kind}\u0000${d.title}`).lastIndexOf(`${event.kind}\u0000${event.title ?? ''}`)
        this.dialogs.splice(index === -1 ? this.dialogs.length - 1 : index, 1)
        out.push(this.dialogOutput())
        break
      }
      default:
        // session_shutdown, agent_end, turn_start, tool_execution_end, input:
        // observed but carry no state of their own (see the rules above).
        break
    }
    return out
  }

  /**
   * The bridge went away while pi is still running: nothing is known about
   * activity any more. NOT idle (spec §5.4 rule 8) — an open turn stays open
   * until the durable file or a reconnect says otherwise.
   */
  bridgeLost(): LiveOutput[] {
    return [{ kind: 'activity', active: null, status: 'unknown' }]
  }

  /** pi exited: close everything this projector opened. */
  endForExit(): LiveOutput[] {
    const out: LiveOutput[] = []
    if (this.turnId) out.push(...this.endTurn(null))
    if (this.dialogs.length || this.trustPending) {
      this.dialogs = []
      this.trustPending = false
      out.push(this.dialogOutput())
    }
    return out
  }

  private endTurn(leafId: string | null): LiveOutput[] {
    const out: LiveOutput[] = []
    if (this.turnId) {
      out.push({ kind: 'turn-end', turnId: this.turnId, leafId })
      this.turnId = null
    }
    out.push(...this.setPhase('idle'))
    out.push({ kind: 'activity', active: false, status: 'idle' })
    return out
  }

  private setPhase(phase: StreamPhase, toolName?: string): LiveOutput[] {
    if (phase === this.phase && !toolName) return []
    this.phase = phase
    return [{ kind: 'phase', phase, turnId: this.turnId, ...(toolName ? { toolName } : {}) }]
  }

  private dialogOutput(): LiveOutput {
    return { kind: 'dialogs', dialog: this.dialogs.at(-1) ?? null, trustPending: this.trustPending }
  }
}
