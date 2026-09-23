// Channel vocabulary, shaped like the sibling headless packages' so Agent Code
// adapters read every provider the same way.
//
// WHY `source: 'pi-bridge'`: the semantic events genuinely come from the
// bridge extension inside Pi. Agent Code's per-provider semantic fold policy
// keys on the source string, so Pi gets its own and the renderer decides
// explicitly how much to trust it.

import type { PiSessionRow } from '../transcript/SessionFile.js'
import type { PendingDialog, StreamPhase } from '../live/types.js'

export type SemanticSource = 'pi-bridge'

export type SemanticTurnStartedEvent = { type: 'turn_started'; turnId: string; role: 'assistant'; source: SemanticSource; confidence: 'high'; ts: number }
export type SemanticTurnCompletedEvent = { type: 'turn_completed'; turnId: string; fullText: string; source: SemanticSource; confidence: 'high'; ts: number }
export type SemanticStreamPhaseEvent = { type: 'stream_phase'; turnId: string | null; phase: StreamPhase; toolName?: string; source: SemanticSource; ts: number }
export type SemanticApiErrorEvent = {
  type: 'api_error'
  turnId: string | null
  message: string
  /** Pi's stopReason: 'error' (provider failure) or 'aborted' (Esc / abort) — lets a consumer tell them apart without parsing text. */
  errorType?: string
  source: SemanticSource
  ts: number
}

export type SemanticEvent = SemanticTurnStartedEvent | SemanticTurnCompletedEvent | SemanticStreamPhaseEvent | SemanticApiErrorEvent

export type ScreenActivityEvent = { type: 'activity'; active: boolean; status: string | null; ts: number }
export type ScreenDialogEvent = { type: 'dialog'; state: PendingDialog | null; trustPending: boolean; ts: number }
export type ScreenEvent = ScreenActivityEvent | ScreenDialogEvent

export type CommittedEntryEvent = { type: 'entry'; row: PiSessionRow; file: string; ts: number }
export type CommittedHistoryEvent = { type: 'history'; kind: 'reset' | 'caught-up'; file: string; ts: number }
export type CommittedTailErrorEvent = { type: 'tail_error'; code: string; message: string; ts: number }
export type CommittedEvent = CommittedEntryEvent | CommittedHistoryEvent | CommittedTailErrorEvent
