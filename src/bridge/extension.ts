// Agent Code's bridge: the Pi extension that turns the native Pi TUI into an
// observable agent. Agent Code passes this file to `pi -e <path>`; Pi loads it
// with jiti into the interactive TUI process.
//
// THIS CODE RUNS INSIDE THE USER'S `pi`. The rules (spec §6) exist because a
// mistake here does not fail a test — it kills someone's session:
//
//  1. Nothing may throw out of an event handler, a socket callback or a timer,
//     and no async error may go unhandled. Stage 0 recorded the failure mode:
//     one unhandled `listen` error inside an extension made Pi exit with
//     "pi exiting due to uncaughtException" and a crash banner on the next
//     start. Every callback below is wrapped, every socket has an `error`
//     listener, and a failing bridge degrades to "no live channel".
//  2. Never listen. The host listens on a private 0700 directory; we connect.
//  3. Self-contained: node builtins only at runtime. Agent Code ships this as
//     one file (out/main/runtime/pi/bridge.ts) where relative imports would
//     not resolve; the protocol import below is type-only and erased.
//  4. Authenticate first: the first frame is a hello with the per-spawn token.
//  5. Observe, don't steer. No tool call is blocked or rewritten, no dialog is
//     answered, no model/tool/setting is changed. The one active operation is
//     the host's explicit prompt/abort request.
//  6. Small payloads: ids, kinds and flags. Message bodies stay in Pi's
//     session file, which the host's durable reader owns.
//  7. Unknown/changed events are ignored, never fatal (Pi ships breaking
//     changes in 0.x minors).
//
// The event vocabulary and the reasons for each mapping come from the Stage 0
// recordings (research/census-2026-09-22.md in pi-terminal-headless).

import { connect, type Socket } from 'node:net'

import type { BridgeEvent, BridgeRequest, ExtensionFrame, PromptOutcome } from './protocol.js'

// Duplicated from ./protocol.ts on purpose (rule 3); extension.test.ts keeps
// them equal.
const BRIDGE_PROTOCOL_VERSION = 1
const BRIDGE_SOCKET_ENV = 'AGENT_CODE_PI_BRIDGE_SOCKET'
const BRIDGE_TOKEN_ENV = 'AGENT_CODE_PI_BRIDGE_TOKEN'

// How long a prompt may take to show up in Pi's conversation or queue before
// we tell the host "unknown". Pi accepts a prompt synchronously into its own
// promise chain; evidence normally arrives within milliseconds. 5 s covers a
// busy event loop without making a caller wait on a prompt Pi silently lost.
const PROMPT_EVIDENCE_DEADLINE_MS = 5_000
const PROMPT_EVIDENCE_POLL_MS = 20
// Reconnect budget after the host goes away (app restart, socket hiccup).
// Bounded: a host that is gone for good must not leave a timer spinning in
// the user's Pi forever.
const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000]
// Events buffered while (re)connecting. They are hints — the session file is
// the record — so dropping the oldest past this bound loses nothing durable.
const MAX_QUEUED_FRAMES = 500

type AnyCtx = any
type AnyPi = any

function guard(fn: () => void): void {
  try {
    fn()
  } catch {
    // Rule 1. There is nowhere safe to report from inside Pi; the host sees
    // the consequence (a missing event) and the durable reader still works.
  }
}

/** The socket link to the host: connect, authenticate, queue, reconnect — never throw. */
class HostLink {
  private socket: Socket | undefined
  private connected = false
  private connecting = false
  private closing = false
  private attempt = 0
  private queue: string[] = []
  private buffer = ''

  constructor(
    private readonly socketPath: string,
    private readonly hello: () => ExtensionFrame,
    private readonly onRequest: (id: number, request: BridgeRequest) => void,
  ) {}

  ensure(): void {
    if (this.connected || this.connecting || this.closing) return
    this.connecting = true
    let socket: Socket
    try {
      socket = connect(this.socketPath)
    } catch {
      this.connecting = false
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    socket.setNoDelay?.(true)
    socket.on('error', () => {
      // Rule 1: the 'error' listener is what keeps a refused/broken socket
      // from becoming an uncaught exception. 'close' follows and reconnects.
    })
    socket.on('connect', () => guard(() => {
      this.connecting = false
      this.connected = true
      this.attempt = 0
      socket.write(JSON.stringify(this.hello()) + '\n')
      const queued = this.queue
      this.queue = []
      for (const line of queued) socket.write(line)
    }))
    socket.on('data', (data: Buffer) => guard(() => this.receive(data)))
    socket.on('close', () => guard(() => {
      if (this.socket !== socket) return
      this.connected = false
      this.connecting = false
      this.socket = undefined
      this.buffer = ''
      if (!this.closing) this.scheduleReconnect()
    }))
  }

  send(frame: ExtensionFrame): void {
    const line = JSON.stringify(frame) + '\n'
    if (this.connected && this.socket) {
      this.socket.write(line)
      return
    }
    this.queue.push(line)
    if (this.queue.length > MAX_QUEUED_FRAMES) this.queue.shift()
    this.ensure()
  }

  close(): void {
    this.closing = true
    guard(() => this.socket?.end())
  }

  private scheduleReconnect(): void {
    if (this.closing || this.attempt >= RECONNECT_DELAYS_MS.length) return
    const delay = RECONNECT_DELAYS_MS[this.attempt]!
    this.attempt += 1
    const timer = setTimeout(() => guard(() => this.ensure()), delay)
    // Never keep pi alive just to reconnect.
    timer.unref?.()
  }

  private receive(data: Buffer): void {
    this.buffer += data.toString('utf8')
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (!line.trim()) continue
      let frame: any
      try {
        frame = JSON.parse(line)
      } catch {
        continue
      }
      if (frame && frame.t === 'request' && typeof frame.id === 'number' && typeof frame.op === 'string') {
        this.onRequest(frame.id, frame as BridgeRequest)
      }
    }
  }
}

function messageText(message: any): string | undefined {
  if (!message || message.role !== 'user') return undefined
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return undefined
  return message.content.filter((block: any) => block?.type === 'text').map((block: any) => String(block.text ?? '')).join('\n')
}

function phaseOf(assistantEventType: unknown): 'thinking' | 'responding' | 'tool' | undefined {
  if (typeof assistantEventType !== 'string') return undefined
  if (assistantEventType.startsWith('thinking')) return 'thinking'
  if (assistantEventType.startsWith('text')) return 'responding'
  if (assistantEventType.startsWith('toolcall')) return 'tool'
  return undefined
}

type Delivery = { id: number; text: string; entered: boolean; timer?: ReturnType<typeof setTimeout>; poll?: ReturnType<typeof setInterval> }

/**
 * Process-wide bridge state.
 *
 * WHY a singleton on globalThis: Pi re-runs every extension factory whenever
 * it rebuilds its runtime — on /reload AND on every session replacement
 * (/new, /resume, /fork, /clone go through AgentSessionRuntime.createRuntime,
 * which reloads resources; agent-session-runtime.ts in the pinned release).
 * A per-factory link would open a second connection per switch, and a
 * per-factory read of the env would find it already deleted (below) and go
 * inert after the first /new. One link per `pi` process survives every
 * runtime; each factory only re-registers handlers and becomes the `pi` that
 * requests are executed against (a replaced runtime's `pi` throws "stale").
 */
type BridgeState = {
  link: HostLink
  pi: AnyPi
  ctx: AnyCtx
  piVersion?: string
  lastPhase?: string
  deliveries: Delivery[]
}

const STATE_KEY = Symbol.for('agent-code.pi-bridge')
/** Pi's TUI syntax: `/compact` plus optional free-text instructions. */
const COMPACT_COMMAND = /^\/compact(?:\s+([\s\S]*?))?\s*$/

function bridgeState(pi: AnyPi): BridgeState | undefined {
  const holder = globalThis as unknown as Record<symbol, BridgeState | null | undefined>
  const existing = holder[STATE_KEY]
  if (existing) {
    existing.pi = pi
    return existing
  }
  if (existing === null) return undefined // already found no host in this process
  const socketPath = process.env[BRIDGE_SOCKET_ENV]
  const token = process.env[BRIDGE_TOKEN_ENV]
  // Hygiene: Pi's bash tool inherits this process's env. The token only
  // authenticates to a socket that already has its peer, but a model has no
  // business reading it. Safe to delete: later factories use the singleton.
  delete process.env[BRIDGE_SOCKET_ENV]
  delete process.env[BRIDGE_TOKEN_ENV]
  // Loaded without a host (someone ran `pi -e bridge.ts` by hand): inert.
  if (!socketPath || !token) {
    holder[STATE_KEY] = null
    return undefined
  }
  const state: BridgeState = {
    pi,
    ctx: undefined,
    deliveries: [],
    link: undefined as unknown as HostLink,
  }
  state.link = new HostLink(
    socketPath,
    () => ({ t: 'hello', token, protocol: BRIDGE_PROTOCOL_VERSION, pid: process.pid, ...(state.piVersion ? { piVersion: state.piVersion } : {}) }),
    (id, request) => guard(() => handleRequest(state, id, request)),
  )
  // Pi's version, best effort, for the host's compatibility diagnostics. A
  // computed specifier keeps TypeScript from resolving Pi's package (not a
  // dependency of this package); at runtime Pi's jiti aliases it.
  const piModule = '@earendil-works/pi-coding-agent'
  void import(piModule).then(
    (module: any) => { if (typeof module?.VERSION === 'string') state.piVersion = module.VERSION },
    () => undefined,
  )
  holder[STATE_KEY] = state
  return state
}

function identity(c: AnyCtx): { sessionId: string; file: string; leafId: string | null } {
  const sm = c?.sessionManager
  return {
    sessionId: String(sm?.getSessionId?.() ?? ''),
    file: String(sm?.getSessionFile?.() ?? ''),
    leafId: (sm?.getLeafId?.() ?? null) as string | null,
  }
}

function emit(state: BridgeState, event: BridgeEvent): void {
  guard(() => state.link.send({ t: 'event', at: Date.now(), event }))
}

function reply(state: BridgeState, id: number, ok: boolean, payload: any): void {
  guard(() => state.link.send((ok ? { t: 'reply', id, ok: true, result: payload } : { t: 'reply', id, ok: false, error: String(payload) }) as ExtensionFrame))
}

function settle(state: BridgeState, delivery: Delivery, outcome: PromptOutcome): void {
  const index = state.deliveries.indexOf(delivery)
  if (index === -1) return
  state.deliveries.splice(index, 1)
  if (delivery.timer) clearTimeout(delivery.timer)
  if (delivery.poll) clearInterval(delivery.poll)
  reply(state, delivery.id, true, { outcome })
}

function handleRequest(state: BridgeState, id: number, request: BridgeRequest): void {
  const c = state.ctx
  if (request.op === 'state') {
    reply(state, id, true, {
      idle: Boolean(c?.isIdle?.() ?? true),
      pending: Boolean(c?.hasPendingMessages?.() ?? false),
      ...(c ? identity(c) : { sessionId: null, file: null, leafId: null }),
    })
    return
  }
  if (request.op === 'abort') {
    c?.abort?.()
    reply(state, id, true, { aborted: true })
    return
  }
  if (request.op === 'prompt') {
    const text = String((request as { text?: unknown }).text ?? '')
    // `/compact [instructions]` is the one built-in command the host sends
    // programmatically: provider switching's opt-in "compact the source
    // first" path delivers it exactly as it does to Claude. Typed into Pi's
    // TUI, it runs compaction. Sent through sendUserMessage it does NOT:
    // sendUserMessage never dispatches built-in commands (agent-session.js
    // prompt(): only extension commands and templates, and only when asked),
    // so the model would receive the literal text "/compact" as a question.
    // ctx.compact() is the same AgentSession.compact the TUI command calls,
    // including aborting a live run first. The durable evidence the host waits
    // for is the compaction row in the session file, so the acknowledgement is
    // simply "started".
    const compact = COMPACT_COMMAND.exec(text)
    if (compact && typeof c?.compact === 'function') {
      c.compact(compact[1] ? { customInstructions: compact[1] } : {})
      reply(state, id, true, { outcome: 'started' })
      return
    }
    const delivery: Delivery = { id, text, entered: false }
    state.deliveries.push(delivery)
    delivery.timer = setTimeout(() => guard(() => settle(state, delivery, 'unknown')), PROMPT_EVIDENCE_DEADLINE_MS)
    delivery.timer.unref?.()
    // ALWAYS followUp (Stage 0 H5): while busy, a prompt without a delivery
    // mode is accepted by the API and silently lost; while idle Pi ignores
    // the mode and starts a run. `sendUserMessage` returning, and even Pi's
    // `input` event, prove nothing — acknowledgement comes only from Pi's own
    // state (the `input` / `message_start` handlers below).
    try {
      state.pi.sendUserMessage(text, { deliverAs: 'followUp' })
    } catch (error) {
      const index = state.deliveries.indexOf(delivery)
      if (index !== -1) state.deliveries.splice(index, 1)
      if (delivery.timer) clearTimeout(delivery.timer)
      reply(state, id, false, (error as Error)?.message ?? error)
    }
    return
  }
  reply(state, id, false, `unknown op ${(request as { op?: unknown }).op}`)
}

export default function agentCodeBridge(pi: AnyPi): void {
  const state = bridgeState(pi)
  if (!state) return
  // The factory itself opens nothing (Pi's rule: some invocations load
  // extensions without starting a session). The link connects from the
  // first project_trust / session_start handler below.

  const on = (name: string, handler: (event: any, c: AnyCtx) => unknown) => {
    guard(() => pi.on(name, (event: any, c: AnyCtx) => {
      if (c) state.ctx = c
      let result: unknown
      guard(() => { result = handler(event, c) })
      return result
    }))
  }

  // Fires BEFORE session_start while Pi's native trust selector is up (H7).
  // Connecting here is the only way the host can show that blocking prompt.
  // 'undecided' leaves the decision to the user, exactly as without us.
  on('project_trust', event => {
    state.link.ensure()
    emit(state, { name: 'project_trust', cwd: String(event?.cwd ?? '') })
    return { trusted: 'undecided' }
  })

  on('session_start', (event, c) => {
    state.link.ensure()
    emit(state, { name: 'session_start', reason: String(event?.reason ?? ''), ...(event?.previousSessionFile ? { previousSessionFile: String(event.previousSessionFile) } : {}), idle: Boolean(c?.isIdle?.() ?? true), ...identity(c) })
  })
  on('session_shutdown', event => {
    emit(state, { name: 'session_shutdown', reason: String(event?.reason ?? ''), ...(event?.targetSessionFile ? { targetSessionFile: String(event.targetSessionFile) } : {}) })
    // Only the process quitting ends the link: /new, /resume, /fork and
    // /reload shut one runtime down and start another in the same process.
    if (event?.reason === 'quit') state.link.close()
  })
  on('session_tree', event => emit(state, {
    name: 'session_tree',
    newLeafId: event?.newLeafId ?? null,
    oldLeafId: event?.oldLeafId ?? null,
    ...(event?.summaryEntry?.id ? { summaryEntryId: String(event.summaryEntry.id) } : {}),
  }))
  on('session_before_compact', event => emit(state, { name: 'compaction_start', ...(event?.reason ? { reason: String(event.reason) } : {}) }))
  on('session_compact', event => emit(state, { name: 'session_compact', ...(event?.compactionEntry?.id ? { compactionEntryId: String(event.compactionEntry.id) } : {}), fromExtension: Boolean(event?.fromExtension) }))
  on('session_compact_failed', event => emit(state, { name: 'session_compact_failed', ...(event?.errorMessage ? { errorMessage: String(event.errorMessage) } : {}) }))

  on('agent_start', () => {
    state.lastPhase = undefined
    emit(state, { name: 'agent_start' })
  })
  on('agent_end', event => emit(state, { name: 'agent_end', willRetry: Boolean(event?.willRetry) }))
  on('agent_settled', (_event, c) => emit(state, { name: 'agent_settled', leafId: identity(c).leafId }))
  on('turn_start', event => emit(state, { name: 'turn_start', turnIndex: Number(event?.turnIndex ?? 0) }))
  on('turn_end', event => emit(state, {
    name: 'turn_end',
    turnIndex: Number(event?.turnIndex ?? 0),
    ...(typeof event?.messageEntryId === 'string' ? { messageEntryId: event.messageEntryId } : {}),
    toolResultEntryIds: Array.isArray(event?.toolResultEntryIds) ? event.toolResultEntryIds.map(String) : [],
    ...(event?.message?.stopReason ? { stopReason: String(event.message.stopReason) } : {}),
    ...(event?.message?.errorMessage ? { errorMessage: String(event.message.errorMessage) } : {}),
  }))

  // Phase hints: forwarded on CHANGE only, which bounds them to a handful per
  // turn no matter how many deltas stream (rule 6).
  const phase = (next: 'thinking' | 'responding' | 'tool' | undefined) => {
    if (!next || next === state.lastPhase) return
    state.lastPhase = next
    emit(state, { name: 'phase', phase: next })
  }
  on('message_update', event => phase(phaseOf(event?.assistantMessageEvent?.type)))
  on('tool_execution_start', event => {
    phase('tool')
    emit(state, { name: 'tool_execution_start', toolCallId: String(event?.toolCallId ?? ''), toolName: String(event?.toolName ?? '') })
  })
  on('tool_execution_end', event => emit(state, { name: 'tool_execution_end', toolCallId: String(event?.toolCallId ?? ''), toolName: String(event?.toolName ?? ''), isError: Boolean(event?.isError) }))

  on('ui_prompt_start', event => emit(state, { name: 'ui_prompt_start', kind: String(event?.kind ?? ''), ...(event?.title ? { title: String(event.title) } : {}) }))
  on('ui_prompt_end', event => emit(state, { name: 'ui_prompt_end', kind: String(event?.kind ?? ''), ...(event?.title ? { title: String(event.title) } : {}) }))

  // Prompt acknowledgement, from Pi's own state (see handleRequest).
  on('input', (event, c) => {
    emit(state, { name: 'input', source: String(event?.source ?? ''), ...(event?.streamingBehavior ? { streamingBehavior: String(event.streamingBehavior) } : {}) })
    if (event?.source !== 'extension') return
    const delivery = state.deliveries.find(d => !d.entered && d.text === event?.text)
    if (!delivery) return
    delivery.entered = true
    if (c?.isIdle?.()) return // idle ⇒ a run starts; message_start settles it as 'started'
    // Busy ⇒ Pi queues after the input handlers return (prompt() awaits them
    // first); poll briefly for the queue to hold it.
    delivery.poll = setInterval(() => guard(() => {
      if (c?.hasPendingMessages?.()) settle(state, delivery, 'queued')
    }), PROMPT_EVIDENCE_POLL_MS)
    delivery.poll.unref?.()
  })
  on('message_start', event => {
    const text = messageText(event?.message)
    if (text === undefined) return
    const delivery = state.deliveries.find(d => d.text === text)
    if (delivery) settle(state, delivery, 'started')
  })
}
