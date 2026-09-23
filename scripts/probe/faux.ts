// Stage 0 probe extension: a scripted model so recordings need no login,
// network or quota.
//
// WHY Pi's own `fauxProvider` and not a mock of Pi: the point of Stage 0 is
// to record what the REAL Pi agent loop, session writer and TUI do. Only the
// model is fake; every write order, event order and file shape comes from
// the pinned Pi release. The faux provider streams tokens at a configurable
// rate, so aborts and "prompt while busy" can land mid-stream exactly as
// they would with a real model.
//
// The reply is chosen from markers in the LAST user text, so one extension
// serves every scenario and a scenario is readable from its prompts alone:
//   [tool]   one bash tool call, then a final text reply (a two-step run)
//   [error]  an assistant message with stopReason "error" (provider failure)
//   [slow]   a long reply, so Esc / a queued prompt can interrupt mid-stream
//   (none)   a short text reply
// Pi's own summarization requests (compaction, branch summary) carry no
// marker and get the default reply, which is a perfectly good summary text.
//
// This file is loaded by Pi through jiti, so it may import only node
// builtins and Pi's bundled virtual modules.

import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai'

type AnyMessage = { role?: string; content?: unknown }

function textOf(message: AnyMessage | undefined): string {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content
    .map(block => (block && typeof block === 'object' && (block as { type?: string }).type === 'text' ? String((block as { text?: unknown }).text ?? '') : ''))
    .join('')
}

export default function (pi: any) {
  const faux = fauxProvider({ tokensPerSecond: Number(process.env.PI_PROBE_TPS ?? 400) })

  const respond = (context: { messages?: AnyMessage[] }) => {
    const messages = context.messages ?? []
    const last = messages[messages.length - 1]
    // A tool result is the second step of a [tool] run: finish with text.
    if (last?.role === 'toolResult') return fauxAssistantMessage('Tool finished. Done.')
    const lastUser = [...messages].reverse().find(m => m.role === 'user')
    const text = textOf(lastUser)
    if (text.includes('[tool]')) {
      return fauxAssistantMessage(
        [fauxThinking('I should run a command.'), fauxText('Running a command.'), fauxToolCall('bash', { command: 'echo probe-tool-output' })],
        { stopReason: 'toolUse' },
      )
    }
    if (text.includes('[error]')) {
      return fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'probe: simulated provider error' })
    }
    if (text.includes('[slow]')) {
      return fauxAssistantMessage([fauxThinking('Thinking slowly.'), fauxText('word '.repeat(1200))])
    }
    return fauxAssistantMessage(`Reply to a ${text.length}-character prompt.`)
  }

  // WHY a long queue of the same factory: the faux provider consumes one
  // step per model call and errors when the queue is empty. A scenario never
  // needs more than a few dozen calls.
  faux.setResponses(Array.from({ length: 200 }, () => respond))
  pi.registerProvider(faux.provider)
}
