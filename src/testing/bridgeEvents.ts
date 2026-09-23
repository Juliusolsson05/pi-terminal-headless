// Turns a Stage 0 recording's extension events into the BridgeEvent stream the
// production bridge would have sent for the same Pi run.
//
// WHY a translation and not re-recording through the bridge: the recorder
// (scripts/probe/recorder.ts) captured Pi's events with more fields than the
// bridge forwards, from the same Pi handlers the bridge subscribes to. This
// mapping mirrors extension.ts field for field; extension.system.test.ts
// checks the extension itself against Pi-shaped payloads, and the live tier
// (PiTerminalHeadless.live.test.ts) runs the real bridge in the real pi. The
// three together keep this helper honest.

import type { BridgeEvent } from '../bridge/protocol.js'
import type { LiveFixture, RecordedEvent } from './fixtures.js'

function phaseOf(ame: unknown): 'thinking' | 'responding' | 'tool' | undefined {
  if (typeof ame !== 'string') return undefined
  if (ame.startsWith('thinking')) return 'thinking'
  if (ame.startsWith('text')) return 'responding'
  if (ame.startsWith('toolcall')) return 'tool'
  return undefined
}

export function bridgeEventsFromRecording(fixture: LiveFixture): Array<{ t: number; event: BridgeEvent }> {
  const out: Array<{ t: number; event: BridgeEvent }> = []
  let lastPhase: string | undefined
  const push = (e: RecordedEvent, event: BridgeEvent) => out.push({ t: e.t, event })
  for (const e of fixture.events) {
    switch (e.name) {
      case 'project_trust':
        push(e, { name: 'project_trust', cwd: String(e.cwd ?? '') })
        break
      case 'session_start':
        push(e, {
          name: 'session_start',
          reason: String(e.reason ?? ''),
          ...(e.previousSessionFile ? { previousSessionFile: String(e.previousSessionFile) } : {}),
          idle: Boolean(e.idle),
          sessionId: String(e.sessionId ?? ''),
          file: String(e.sessionFile ?? ''),
          leafId: (e.leafId ?? null) as string | null,
        })
        break
      case 'session_shutdown':
        push(e, { name: 'session_shutdown', reason: String(e.reason ?? ''), ...(e.targetSessionFile ? { targetSessionFile: String(e.targetSessionFile) } : {}) })
        break
      case 'session_tree': {
        const summary = e.summaryEntry as { id?: string } | undefined
        push(e, { name: 'session_tree', newLeafId: (e.newLeafId ?? null) as string | null, oldLeafId: (e.oldLeafId ?? null) as string | null, ...(summary?.id ? { summaryEntryId: summary.id } : {}) })
        break
      }
      case 'session_before_compact':
        push(e, { name: 'compaction_start', ...(e.reason ? { reason: String(e.reason) } : {}) })
        break
      case 'session_compact':
        push(e, { name: 'session_compact', fromExtension: Boolean(e.fromExtension) })
        break
      case 'session_compact_failed':
        push(e, { name: 'session_compact_failed', ...(e.errorMessage ? { errorMessage: String(e.errorMessage) } : {}) })
        break
      case 'agent_start':
        lastPhase = undefined
        push(e, { name: 'agent_start' })
        break
      case 'agent_end':
        push(e, { name: 'agent_end', willRetry: Boolean(e.willRetry) })
        break
      case 'agent_settled':
        push(e, { name: 'agent_settled', leafId: (e.leafId ?? null) as string | null })
        break
      case 'turn_start':
        push(e, { name: 'turn_start', turnIndex: Number(e.turnIndex ?? 0) })
        break
      case 'turn_end': {
        const message = e.message as { stopReason?: string; errorMessage?: string } | undefined
        push(e, {
          name: 'turn_end',
          turnIndex: Number(e.turnIndex ?? 0),
          ...(typeof e.messageEntryId === 'string' ? { messageEntryId: e.messageEntryId } : {}),
          toolResultEntryIds: Array.isArray(e.toolResultEntryIds) ? (e.toolResultEntryIds as string[]) : [],
          ...(message?.stopReason ? { stopReason: message.stopReason } : {}),
          ...(message?.errorMessage ? { errorMessage: message.errorMessage } : {}),
        })
        break
      }
      case 'message_update': {
        const phase = phaseOf(e.ame)
        if (phase && phase !== lastPhase) {
          lastPhase = phase
          push(e, { name: 'phase', phase })
        }
        break
      }
      case 'tool_execution_start':
        lastPhase = 'tool'
        push(e, { name: 'tool_execution_start', toolCallId: String(e.toolCallId ?? ''), toolName: String(e.toolName ?? '') })
        break
      case 'tool_execution_end':
        push(e, { name: 'tool_execution_end', toolCallId: String(e.toolCallId ?? ''), toolName: String(e.toolName ?? ''), isError: Boolean(e.isError) })
        break
      case 'ui_prompt_start':
      case 'ui_prompt_end':
        push(e, { name: e.name, kind: String(e.kind ?? ''), ...(e.title ? { title: String(e.title) } : {}) })
        break
      case 'input':
        push(e, { name: 'input', source: String(e.source ?? ''), ...(e.streamingBehavior ? { streamingBehavior: String(e.streamingBehavior) } : {}) })
        break
      default:
        break
    }
  }
  return out
}
