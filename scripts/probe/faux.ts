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
//   [mcp]    one call to the bridge-proxied Agent Code MCP tool
//            `mcp__agent_code__echo` (the bridge live test's local server),
//            whose argument reports what the model was actually given:
//            whether that tool was declared in the request and whether the
//            system prompt carried the MCP server instructions section
//   [call:NAME {json}]  one call to the tool NAME with those JSON arguments
//            (optional; none means {}). Agent Code's app live test names a
//            real built-in MCP tool this way. Then a text reply once its
//            result is back.
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
    const call = /\[call:([A-Za-z0-9_-]+)(?: (\{[^\]]*\}))?\]/.exec(text)
    if (call) return fauxAssistantMessage([fauxToolCall(call[1]!, call[2] ? JSON.parse(call[2]) : {})], { stopReason: 'toolUse' })
    if (text.includes('[mcp]')) {
      // pi 0.87.1 hands providers a transcript context: the prompt, its
      // named sections and the tool declarations travel as `system`
      // messages (`sections`, `toolsAdded`), not as systemPrompt/tools fields.
      const system = (context.messages ?? []).filter(m => m.role === 'system') as Array<AnyMessage & { toolsAdded?: Array<{ name?: string }> }>
      const hasTool = system.some(m => (m.toolsAdded ?? []).some(tool => tool.name === 'mcp__agent_code__echo'))
      const hasInstructions = system.some(m => JSON.stringify(m).includes('# MCP Server Instructions'))
      return fauxAssistantMessage(
        [fauxToolCall('mcp__agent_code__echo', { text: `tool:${hasTool} instructions:${hasInstructions}` })],
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
