// Stage 0 probe extension: records every extension event Pi fires inside the
// interactive TUI, plus the size of the session file at that instant, and
// exposes a tiny control socket so the probe can inject prompts / aborts the
// way the production bridge will.
//
// WHY record the file size with every event: the durable reader needs to know
// whether an event is a valid "doorbell" (spec hypothesis H3: when the bridge
// sees `message_end`, is the row already on disk?). Sampling `stat().size`
// inside the handler answers that directly, with no timing guesswork.
//
// WHY the probe (not this extension) listens on the socket: the production
// bridge must never `listen` (spec §6 rule 2 — an extension listen error kills
// `pi`). Recording with the same direction keeps the evidence honest about
// the path production will use.
//
// Deliberately NOT the production bridge: this recorder logs a superset of
// payload fields to discover shapes; the bridge (src/bridge/extension.ts)
// forwards only what the pipeline needs.
//
// Loaded by Pi through jiti: node builtins only, no package imports.

import { appendFileSync, statSync } from 'node:fs'
import { connect, type Socket } from 'node:net'

const OUT = process.env.PI_PROBE_EVENTS ?? ''
const SOCKET = process.env.PI_PROBE_SOCKET ?? ''
const T0 = Number(process.env.PI_PROBE_T0 ?? Date.now())

const EVENTS = [
  'session_start', 'session_shutdown', 'session_info_changed', 'session_before_switch', 'session_before_fork',
  'session_before_compact', 'session_compact', 'session_compact_failed', 'session_before_tree', 'session_tree',
  'resources_discover', 'before_agent_start', 'agent_start', 'agent_end', 'agent_before_settle', 'agent_settled',
  'turn_start', 'turn_end', 'message_start', 'message_update', 'message_end', 'tool_execution_start',
  'tool_execution_update', 'tool_execution_end', 'tool_call', 'tool_result', 'input', 'model_select',
  'thinking_level_select', 'ui_prompt_start', 'ui_prompt_end', 'user_bash',
] as const

function write(record: Record<string, unknown>): void {
  if (!OUT) return
  try {
    appendFileSync(OUT, JSON.stringify({ t: Date.now() - T0, ...record }) + '\n')
  } catch {
    // Recording must never crash pi.
  }
}

function fileBytes(file: string | undefined): number {
  if (!file) return -2
  try {
    return statSync(file).size
  } catch {
    return -1 // does not exist yet
  }
}

// Summarize an AgentMessage without its free text (fixtures stay small and the
// shape, not the prose, is what the pipeline depends on).
function messageShape(message: any): Record<string, unknown> | undefined {
  if (!message || typeof message !== 'object') return undefined
  const content = Array.isArray(message.content) ? message.content : null
  return {
    role: message.role,
    stopReason: message.stopReason,
    errorMessage: message.errorMessage,
    contentTypes: content ? content.map((b: any) => b?.type) : typeof message.content,
    toolCallIds: content ? content.filter((b: any) => b?.type === 'toolCall').map((b: any) => b.id) : undefined,
    toolCallId: message.toolCallId,
    customType: message.customType,
    timestamp: message.timestamp,
  }
}

function summarize(event: any): Record<string, unknown> {
  const out: Record<string, unknown> = { keys: Object.keys(event ?? {}).sort() }
  switch (event?.type) {
    case 'message_start':
    case 'message_end':
      out.message = messageShape(event.message)
      break
    case 'message_update':
      out.ame = event.assistantMessageEvent?.type
      break
    case 'turn_end':
      out.turnIndex = event.turnIndex
      out.messageEntryId = event.messageEntryId
      out.toolResultEntryIds = event.toolResultEntryIds
      out.message = messageShape(event.message)
      break
    case 'agent_end':
      out.willRetry = event.willRetry
      out.messageCount = Array.isArray(event.messages) ? event.messages.length : undefined
      break
    case 'input':
      out.source = event.source
      out.streamingBehavior = event.streamingBehavior
      out.textLength = typeof event.text === 'string' ? event.text.length : undefined
      out.probeTag = typeof event.text === 'string' ? (event.text.match(/\[probe:[^\]]+\]/)?.[0] ?? null) : null
      break
    default:
      for (const [key, value] of Object.entries(event ?? {})) {
        if (key === 'type' || key === 'messages' || key === 'context' || key === 'message' || key === 'systemPrompt') continue
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) out[key] = value
        else if (key === 'summaryEntry' && value && typeof value === 'object') out[key] = { id: (value as any).id, type: (value as any).type, parentId: (value as any).parentId }
      }
  }
  return out
}

export default function (pi: any) {
  let lastCtx: any
  let socket: Socket | undefined
  let buffer = ''

  const snapshot = (ctx: any) => {
    const sm = ctx?.sessionManager
    const file = safe(() => sm?.getSessionFile())
    return {
      idle: safe(() => ctx?.isIdle()),
      pending: safe(() => ctx?.hasPendingMessages()),
      sessionId: safe(() => sm?.getSessionId()),
      sessionFile: file,
      leafId: safe(() => sm?.getLeafId()),
      fileBytes: fileBytes(file),
    }
  }

  const handleCommand = (line: string) => {
    let msg: any
    try { msg = JSON.parse(line) } catch { return }
    const ctx = lastCtx
    write({ name: 'probe_command', op: msg.op, tag: msg.tag, ...snapshot(ctx) })
    try {
      if (msg.op === 'prompt') {
        const opts = msg.deliverAs ? { deliverAs: msg.deliverAs } : undefined
        pi.sendUserMessage(msg.text, opts)
        write({ name: 'probe_command_ok', op: msg.op, tag: msg.tag, ...snapshot(ctx) })
      } else if (msg.op === 'abort') {
        ctx?.abort()
        write({ name: 'probe_command_ok', op: msg.op, tag: msg.tag, ...snapshot(ctx) })
      } else if (msg.op === 'state') {
        write({ name: 'probe_state', tag: msg.tag, ...snapshot(ctx) })
      }
    } catch (error) {
      write({ name: 'probe_command_error', op: msg.op, tag: msg.tag, error: String((error as Error)?.message ?? error) })
    }
  }

  const ensureSocket = () => {
    if (!SOCKET || socket) return
    const s = connect(SOCKET)
    socket = s
    s.on('error', error => { write({ name: 'probe_socket_error', error: String(error?.message ?? error) }); socket = undefined })
    s.on('close', () => { socket = undefined })
    s.on('data', data => {
      buffer += data.toString('utf8')
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line) handleCommand(line)
      }
    })
  }

  for (const name of EVENTS) {
    pi.on(name, (event: any, ctx: any) => {
      lastCtx = ctx
      if (name === 'session_start') ensureSocket()
      write({ name, ...snapshot(ctx), ...summarize(event) })
    })
  }

  // H7: can an extension observe (and would it have to decide) the project
  // trust prompt? Returning "undecided" must leave the native prompt in place.
  pi.on('project_trust', (event: any) => {
    write({ name: 'project_trust', cwd: event?.cwd })
    return { trusted: 'undecided' }
  })

  // Probe-only commands that drive session-tree operations through the same
  // runtime methods Pi's own /tree, /fork and /resume selectors call, without
  // scripting their interactive pickers keystroke by keystroke.
  pi.registerCommand('probe-tree', {
    description: 'probe: navigate to an entry',
    handler: async (args: string, ctx: any) => {
      const [target, summarize] = String(args ?? '').trim().split(/\s+/)
      write({ name: 'probe_tree_request', target, summarize: summarize === 'summarize' })
      const result = await ctx.navigateTree(target, { summarize: summarize === 'summarize' })
      write({ name: 'probe_tree_result', cancelled: result?.cancelled })
    },
  })
  pi.registerCommand('probe-fork', {
    description: 'probe: fork at an entry',
    handler: async (args: string, ctx: any) => {
      const result = await ctx.fork(String(args ?? '').trim())
      write({ name: 'probe_fork_result', cancelled: result?.cancelled })
    },
  })
  pi.registerCommand('probe-switch', {
    description: 'probe: switch to a session file',
    handler: async (args: string, ctx: any) => {
      const result = await ctx.switchSession(String(args ?? '').trim())
      write({ name: 'probe_switch_result', cancelled: result?.cancelled })
    },
  })
  pi.registerCommand('probe-confirm', {
    description: 'probe: open a blocking confirm dialog',
    handler: async (_args: string, ctx: any) => {
      const answer = await ctx.ui.confirm('Probe dialog', 'Proceed with the probe?')
      write({ name: 'probe_confirm_result', answer })
    },
  })
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}
