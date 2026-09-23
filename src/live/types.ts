// Vocabulary of the live channel (the bridge), as the rest of the package
// sees it after LiveStateProjector. Pinned by the Stage 0 recordings of Pi
// 0.87.1 (research/census-2026-09-22.md).

/**
 * Same phase names as opencode-terminal-headless, because Agent Code's
 * stream-phase handling is shared across providers. Pi adds 'compacting'
 * (session_before_compact → session_compact), which the renderer already
 * knows from Claude.
 */
export type StreamPhase = 'thinking' | 'responding' | 'tool-use' | 'compacting' | 'idle'

/** A blocking prompt Pi is waiting on, in the shape the condition modules read. */
export type PendingDialog = {
  /** 'confirm' | 'select' | 'input' | 'editor' | 'custom' from Pi's ui_prompt_start. */
  kind: string
  title: string
}

export type LiveOutput =
  /** A run started: Pi's agent_start. One run = one user-visible turn (H4). */
  | { kind: 'turn-start'; turnId: string }
  /** The run settled: Pi's agent_settled (never agent_end — retries and queued prompts continue after it). */
  | { kind: 'turn-end'; turnId: string; leafId: string | null }
  | { kind: 'activity'; active: boolean | null; status: 'busy' | 'idle' | 'unknown' }
  | { kind: 'phase'; phase: StreamPhase; turnId: string | null; toolName?: string }
  | { kind: 'dialogs'; dialog: PendingDialog | null; trustPending: boolean }
  /** Rows the bridge says are on disk now (H3: turn_end / agent_settled / tree / compact / start). */
  | { kind: 'doorbell'; entryIds: string[] }
  | { kind: 'api-error'; message: string; turnId: string | null; errorType: string }
  /** The live leaf moved without (necessarily) writing a row: a /tree move (H6). */
  | { kind: 'leaf'; leafId: string | null }
  /** Pi now writes a different session (startup, /new, /resume, /fork, /clone). */
  | { kind: 'session'; sessionId: string; file: string; leafId: string | null; reason: string }
