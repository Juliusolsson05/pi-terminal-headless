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
//     answered, no model or setting is changed. The active operations are the
//     host's explicit prompt/abort requests (a delivered `/compact` included)
//     and the Agent Code MCP tools the host configured for this launch, added
//     as tools of their own. No built-in tool is replaced.
//  6. Small payloads: ids, kinds and flags. Message bodies stay in Pi's
//     session file, which the host's durable reader owns.
//  7. Unknown/changed events are ignored, never fatal (Pi ships breaking
//     changes in 0.x minors).
//
// The event vocabulary and the reasons for each mapping come from the Stage 0
// recordings (research/census-2026-09-22.md in pi-terminal-headless).

import { connect, type Socket } from 'node:net'
import { resolve as resolvePath } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import type { BridgeEvent, BridgeRequest, ExtensionFrame, PromptOutcome } from './protocol.js'

// Duplicated from ./protocol.ts on purpose (rule 3); extension.test.ts keeps
// them equal.
const BRIDGE_PROTOCOL_VERSION = 1
const BRIDGE_SOCKET_ENV = 'AGENT_CODE_PI_BRIDGE_SOCKET'
const BRIDGE_TOKEN_ENV = 'AGENT_CODE_PI_BRIDGE_TOKEN'
const MCP_SERVERS_ENV = 'AGENT_CODE_PI_MCP_SERVERS'

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
  // Per connection (reset with `buffer` on close). WHY: the host's request
  // frames carry user prompt text, and a socket chunk can end inside a
  // multibyte character; decoding each chunk alone turns 🌍 into four U+FFFD
  // and Pi runs an altered prompt (Astra review, finding 9).
  private decoder = new StringDecoder('utf8')

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
      this.decoder = new StringDecoder('utf8')
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
    this.buffer += this.decoder.write(data)
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

// ---------------------------------------------------------------------------
// Agent Code's built-in MCP servers, proxied as Pi tools.
//
// WHY a proxy inside the bridge: Pi has no MCP client, by design (its README:
// "No MCP. Build CLI tools with READMEs, or build an extension that adds MCP
// support"). Claude, Codex, OpenCode and Grok each receive the same per-launch
// HTTP endpoints (tldr, goal, orchestration, transcripts, ...) through their
// own MCP config. Pi receives them here: the bridge speaks the MCP
// Streamable HTTP transport to each endpoint and registers every listed tool
// with pi.registerTool.
//
// Shape of the client, from the host it talks to (BuiltInMcpHttpHost):
// stateless (no Mcp-Session-Id), and every POST answered as an SSE stream
// whose `data:` event carries the JSON-RPC reply. A JSON body is accepted too,
// so a future `enableJsonResponse` host keeps working. No GET notification
// stream is opened, because the host sends no server notifications.
//
// Tool names follow Claude Code's `mcp__<server>__<tool>`. That is what Agent
// Code's own prompts, skills and orchestration briefs name, so an instruction
// written for any provider resolves the same way here.
//
// Credentials: the host passes header VALUES in their own env vars and only
// their names in the JSON (never argv). All of it is removed from
// process.env on first read, because Pi's bash tool inherits the environment
// and a model has no business reading the bearer.
// ---------------------------------------------------------------------------

type McpServerSpec = { name: string; url: string; headerEnv: Record<string, string> }
type McpServer = { name: string; url: string; headers: Record<string, string> }
type McpTool = { server: McpServer; toolName: string; piName: string; description: string; inputSchema: Record<string, unknown> }
type McpDiscovery = { tools: McpTool[]; instructions: Array<{ server: string; text: string }> }

// MCP revision this client speaks. The SDK server behind every Agent Code
// endpoint negotiates down from it if it must, and we then send the version it
// chose on every later request, as the transport spec requires.
const MCP_PROTOCOL_VERSION = '2025-06-18'
// Discovery must never hold a user's first prompt for long. A host that has
// not answered in this time is not going to, and the turn runs without tools.
const MCP_DISCOVERY_TIMEOUT_MS = 10_000
// Provider tool-name limit (Anthropic and OpenAI both cap at 64, [A-Za-z0-9_-]).
const TOOL_NAME_LIMIT = 64

function readMcpServers(): McpServer[] {
  const raw = process.env[MCP_SERVERS_ENV]
  delete process.env[MCP_SERVERS_ENV]
  if (!raw) return []
  let specs: McpServerSpec[]
  try {
    specs = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(specs)) return []
  const servers: McpServer[] = []
  for (const spec of specs) {
    if (!spec || typeof spec.name !== 'string' || typeof spec.url !== 'string') continue
    const headers: Record<string, string> = {}
    for (const [header, variable] of Object.entries(spec.headerEnv ?? {})) {
      const value = process.env[variable]
      delete process.env[variable]
      if (typeof value === 'string') headers[header] = value
    }
    servers.push({ name: spec.name, url: spec.url, headers })
  }
  return servers
}

function piToolName(server: string, tool: string): string {
  const clean = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_')
  return `mcp__${clean(server)}__${clean(tool)}`.slice(0, TOOL_NAME_LIMIT)
}

/** 8 hex chars of FNV-1a: stable across processes, no crypto import needed. */
function shortHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** JSON-RPC messages from an SSE body: every `data:` payload that parses. */
function sseMessages(body: string): any[] {
  const messages: any[] = []
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
    if (!data) continue
    try {
      messages.push(JSON.parse(data))
    } catch {
      // A keep-alive or a partial event; the reply we wait for is elsewhere.
    }
  }
  return messages
}

class McpHttpClient {
  private nextId = 1
  private protocolVersion: string | undefined

  constructor(readonly server: McpServer) {}

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.protocolVersion ? { 'mcp-protocol-version': this.protocolVersion } : {}),
      ...this.server.headers,
    }
  }

  async request(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
    const id = this.nextId++
    const response = await fetch(this.server.url, { method: 'POST', headers: this.headers(), body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal })
    if (!response.ok) throw new Error(`${this.server.name} ${method}: HTTP ${response.status}`)
    const type = response.headers.get('content-type') ?? ''
    const messages = type.includes('text/event-stream') ? sseMessages(await response.text()) : [await response.json()]
    const reply = messages.find(message => message && message.id === id)
    if (!reply) throw new Error(`${this.server.name} ${method}: no reply`)
    if (reply.error) throw new Error(`${this.server.name} ${method}: ${reply.error.message ?? 'error'}`)
    return reply.result
  }

  async notify(method: string, signal?: AbortSignal): Promise<void> {
    const response = await fetch(this.server.url, { method: 'POST', headers: this.headers(), body: JSON.stringify({ jsonrpc: '2.0', method }), signal })
    // 202 Accepted with no body is the spec's answer; drain whatever came.
    await response.text().catch(() => '')
  }

  async initialize(signal: AbortSignal): Promise<string | undefined> {
    const result = await this.request('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'agent-code-pi-bridge', version: String(BRIDGE_PROTOCOL_VERSION) } }, signal)
    this.protocolVersion = typeof result?.protocolVersion === 'string' ? result.protocolVersion : MCP_PROTOCOL_VERSION
    await this.notify('notifications/initialized', signal)
    return typeof result?.instructions === 'string' && result.instructions.trim() ? result.instructions : undefined
  }

  async listTools(signal: AbortSignal): Promise<any[]> {
    const tools: any[] = []
    let cursor: string | undefined
    // Bounded: a host that keeps returning a cursor must not loop forever.
    for (let page = 0; page < 50; page += 1) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, signal)
      if (Array.isArray(result?.tools)) tools.push(...result.tools)
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined
      if (!cursor) break
    }
    return tools
  }
}

async function discoverMcp(servers: McpServer[], clients: Map<string, McpHttpClient>, report: (status: Array<{ name: string; tools: number; error?: string }>) => void): Promise<McpDiscovery> {
  const signal = AbortSignal.timeout(MCP_DISCOVERY_TIMEOUT_MS)
  const discovery: McpDiscovery = { tools: [], instructions: [] }
  const status: Array<{ name: string; tools: number; error?: string }> = []
  await Promise.all(servers.map(async server => {
    try {
      const client = new McpHttpClient(server)
      const instructions = await client.initialize(signal)
      const tools = await client.listTools(signal)
      clients.set(server.name, client)
      if (instructions) discovery.instructions.push({ server: server.name, text: instructions })
      for (const tool of tools) {
        if (!tool || typeof tool.name !== 'string') continue
        discovery.tools.push({
          server, toolName: tool.name, piName: '',
          description: typeof tool.description === 'string' ? tool.description : '',
          inputSchema: toolParameters(tool.inputSchema),
        })
      }
      status.push({ name: server.name, tools: tools.length })
    } catch (error) {
      status.push({ name: server.name, tools: 0, error: String((error as Error)?.message ?? error) })
    }
  }))
  // Pi names must be unique: registerTool silently REPLACES a same-named
  // tool, and the model would then call the wrong one. Sanitizing (`a.b` and
  // `a_b`) and the 64-character cut can both collide, so a collision gets a
  // short stable hash of its real server/tool identity.
  const taken = new Set<string>()
  for (const tool of discovery.tools) {
    let name = piToolName(tool.server.name, tool.toolName)
    if (taken.has(name)) {
      const suffix = `_${shortHash(`${tool.server.name}/${tool.toolName}`)}`
      name = name.slice(0, TOOL_NAME_LIMIT - suffix.length) + suffix
    }
    taken.add(name)
    tool.piName = name
  }
  report(status)
  return discovery
}

/**
 * The MCP inputSchema as Pi tool parameters. Pi validates arguments against
 * a plain JSON Schema directly (pi-ai validation.js takes its JSON-schema
 * coercion path when the TypeBox symbol is absent), so no TypeBox wrapper is
 * needed. `$schema` is dropped because it only names a dialect, which the
 * validator must not be asked to fetch. A missing or non-object schema
 * becomes "no arguments", since registerTool refuses anything but an object
 * schema.
 */
function toolParameters(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { type: 'object', properties: {} }
  const { $schema: _dialect, ...rest } = schema as Record<string, unknown>
  return rest.type === 'object' ? rest : { type: 'object', properties: {} }
}

/** An MCP tools/call result as Pi tool content. */
function toolContent(result: any): Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> {
  const out: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = []
  for (const block of Array.isArray(result?.content) ? result.content : []) {
    if (block?.type === 'text' && typeof block.text === 'string') out.push({ type: 'text', text: block.text })
    else if (block?.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') out.push({ type: 'image', data: block.data, mimeType: block.mimeType })
    // Resources, links and audio have no Pi content type. The model still
    // gets them, as the JSON the server sent, rather than losing them.
    else if (block) out.push({ type: 'text', text: JSON.stringify(block) })
  }
  if (out.length === 0 && result?.structuredContent !== undefined) out.push({ type: 'text', text: JSON.stringify(result.structuredContent) })
  return out.length ? out : [{ type: 'text', text: '(no output)' }]
}

function registerMcpTools(pi: AnyPi, discovery: McpDiscovery): void {
  for (const tool of discovery.tools) {
    guard(() => pi.registerTool({
      name: tool.piName,
      label: `${tool.server.name}: ${tool.toolName}`,
      description: tool.description,
      parameters: tool.inputSchema,
      async execute(_toolCallId: string, params: unknown, signal: AbortSignal | undefined) {
        // Looked up through the process-wide state, never a module variable:
        // Pi loads extensions with jiti `moduleCache: false` and clears its
        // extension cache on /reload (and on a /resume into another cwd), so
        // this FILE is evaluated again while the globalThis state (and its
        // discovered tools) survives. A module-scope map would be empty in
        // the new copy, and every tool would fail as "not connected".
        const client = currentBridgeState()?.mcpClients.get(tool.server.name)
        if (!client) throw new Error(`Agent Code MCP server ${tool.server.name} is not connected`)
        const result = await client.request('tools/call', { name: tool.toolName, arguments: params ?? {} }, signal)
        const content = toolContent(result)
        // Pi marks a tool result as an error when execute throws, which is
        // how an MCP `isError` must reach the model and the TUI.
        if (result?.isError === true) throw new Error(content.map(block => block.type === 'text' ? block.text : '').join('\n') || 'MCP tool reported an error')
        return { content, details: { server: tool.server.name, tool: tool.toolName } }
      },
    }))
  }
}

/** Server instructions, as Claude Code presents them, in their own prompt section. */
function mcpInstructionsSection(discovery: McpDiscovery): string | undefined {
  if (discovery.instructions.length === 0) return undefined
  return ['# MCP Server Instructions', '', 'The following MCP servers have provided instructions for how to use their tools and resources:', '',
    ...discovery.instructions.flatMap(entry => [`## ${entry.server}`, entry.text, ''])].join('\n').trimEnd()
}

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
  mcpServers: McpServer[]
  mcpClients: Map<string, McpHttpClient>
  /** Between session_before_compact and its outcome, Pi refuses every prompt. */
  compacting: boolean
  /** Started at the first session_start, once per process; see ensureMcp. */
  mcp?: Promise<McpDiscovery>
  mcpResult?: McpDiscovery
}

const STATE_KEY = Symbol.for('agent-code.pi-bridge')
/** Pi's TUI syntax: `/compact` plus optional free-text instructions. */
const COMPACT_COMMAND = /^\/compact(?:\s+([\s\S]*?))?\s*$/

/**
 * Pi 0.87.1's built-in TUI commands (dist/core/slash-commands.js,
 * BUILTIN_SLASH_COMMANDS), minus `compact`, which the bridge runs itself.
 *
 * WHY refuse them instead of forwarding: sendUserMessage never dispatches a
 * built-in command, so `/new` from the host reached the MODEL as a question.
 * Seen with a real model (GLM-5.3), which answered that "/new" looks like a
 * command for the pi interface, while the host was told `started` and waited
 * for a session switch that never came. The session-control ones (/new,
 * /fork, /tree, /resume, ...) exist only on a COMMAND context
 * (ExtensionCommandContext), which a bridge driven by socket requests does
 * not hold. So the honest answer is `rejected` with the reason: nothing
 * reached pi, the host says so, and the user can type it in the pane.
 *
 * WHEN THIS DRIFTS: a Pi upgrade that adds a built-in lets that one through
 * as text again, the same failure as before this list existed. Re-read
 * BUILTIN_SLASH_COMMANDS on every accepted-version bump.
 */
const PI_BUILTIN_COMMANDS = new Set([
  'settings', 'model', 'tree', 'thinking', 'scoped-models', 'export', 'import', 'share', 'bug', 'copy', 'name',
  'session', 'changelog', 'hotkeys', 'fork', 'clone', 'trust', 'login', 'logout', 'new', 'resume', 'reload', 'quit',
])
const SLASH_COMMAND = /^\/([a-z][a-z:-]*)(?:\s|$)/

function currentBridgeState(): BridgeState | undefined {
  return (globalThis as unknown as Record<symbol, BridgeState | null | undefined>)[STATE_KEY] ?? undefined
}

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
  // The MCP credentials are scrubbed on this path too: they must never
  // outlive the bridge in an env the model's bash tool can read.
  if (!socketPath || !token) {
    readMcpServers()
    holder[STATE_KEY] = null
    return undefined
  }
  const state: BridgeState = {
    pi,
    ctx: undefined,
    deliveries: [],
    link: undefined as unknown as HostLink,
    mcpServers: readMcpServers(),
    mcpClients: new Map(),
    compacting: false,
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

/**
 * Discover the MCP tools once per pi process and register them on the
 * current runtime.
 *
 * WHY it starts at session_start and not in the factory: Pi's rule is that a
 * factory opens nothing, because some invocations load extensions without ever
 * starting a session. WHY once: the endpoints and their token belong to this
 * launch, and every later runtime (/new, /resume, /fork, /reload) re-runs the
 * factory, which registers the already-discovered tools on its own `pi` (see
 * the factory below). A second discovery would only race the first.
 */
function ensureMcp(state: BridgeState): Promise<McpDiscovery> | undefined {
  if (state.mcpServers.length === 0) return undefined
  state.mcp ??= discoverMcp(state.mcpServers, state.mcpClients, servers => emit(state, { name: 'mcp_status', servers })).then(discovery => {
    state.mcpResult = discovery
    // The runtime that is current when discovery lands gets the tools. Pi
    // activates newly registered extension tools (agent-session.js
    // _refreshToolRegistry adds names not previously registered).
    registerMcpTools(state.pi, discovery)
    return discovery
  }, () => ({ tools: [], instructions: [] }))
  return state.mcp
}

function absoluteSessionFile(file: unknown): string {
  const text = String(file ?? '')
  return text ? resolvePath(text) : ''
}

function identity(c: AnyCtx): { sessionId: string; file: string; leafId: string | null } {
  const sm = c?.sessionManager
  return {
    sessionId: String(sm?.getSessionId?.() ?? ''),
    // Absolute, resolved HERE, where process.cwd() is pi's own. Pi keeps a
    // relative session dir relative (join(dir, name)), and the host — another
    // process with another cwd — cannot resolve it correctly (Astra review,
    // finding 5). '' stays '' (no file yet).
    file: absoluteSessionFile(sm?.getSessionFile?.()),
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
  // Every op answers, even when Pi throws: between session_shutdown and the
  // next session_start the cached ctx belongs to a replaced runtime, and its
  // methods throw "stale". An unanswered request would make the host wait out
  // its timeout and report `unknown`.
  try {
    handleRequestUnsafe(state, id, request)
  } catch (error) {
    reply(state, id, false, (error as Error)?.message ?? error)
  }
}

function handleRequestUnsafe(state: BridgeState, id: number, request: BridgeRequest): void {
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
    // NOTE (TUI behaviour, not ours): interactive pi implements ctx.abort as
    // restoreQueuedMessagesToEditor({ abort: true }), so follow-ups already
    // acknowledged as `queued` go back into the TUI editor instead of running.
    // An abort therefore cancels queued host prompts too; see PromptOutcome.
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
    // Pi REFUSES these before any event we could observe
    // (agent-session.js prompt(): a running compaction throws before `input`,
    // a missing model throws after it), and sendUserMessage returns void,
    // so the refusal never reaches our catch. Without these checks the host
    // would wait out the deadline and get `unknown` ("never resubmit") for a
    // prompt that was simply refused.
    if (state.compacting) {
      reply(state, id, false, 'pi is compacting this session; retry when the compaction finishes')
      return
    }
    const compact = COMPACT_COMMAND.exec(text)
    if (compact && typeof c?.compact !== 'function') {
      // Never fall back to sendUserMessage: that would hand the model the
      // literal text while the host believes a compaction started.
      reply(state, id, false, 'this pi exposes no compaction API to extensions')
      return
    }
    const builtin = compact ? null : SLASH_COMMAND.exec(text.trim())?.[1]
    if (builtin && PI_BUILTIN_COMMANDS.has(builtin)) {
      reply(state, id, false, `/${builtin} is a pi TUI command; type it in the pi pane (sent as a prompt, pi would hand it to the model as text)`)
      return
    }
    if (!compact && c && c.model === undefined) {
      reply(state, id, false, 'pi has no model selected')
      return
    }
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

  // A rebuilt runtime (/new, /resume, /fork, /reload) starts with no
  // extension tools. Registering in the factory is Pi's normal path, and the
  // discovery already holds everything needed.
  if (state.mcpResult) registerMcpTools(pi, state.mcpResult)

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
    void ensureMcp(state)
    emit(state, { name: 'session_start', reason: String(event?.reason ?? ''), ...(event?.previousSessionFile ? { previousSessionFile: String(event.previousSessionFile) } : {}), idle: Boolean(c?.isIdle?.() ?? true), ...identity(c) })
  })
  on('session_shutdown', event => {
    emit(state, { name: 'session_shutdown', reason: String(event?.reason ?? ''), ...(event?.targetSessionFile ? { targetSessionFile: absoluteSessionFile(event.targetSessionFile) } : {}) })
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
  on('session_before_compact', event => {
    state.compacting = true
    emit(state, { name: 'compaction_start', ...(event?.reason ? { reason: String(event.reason) } : {}) })
  })
  on('session_compact', event => {
    state.compacting = false
    emit(state, { name: 'session_compact', ...(event?.compactionEntry?.id ? { compactionEntryId: String(event.compactionEntry.id) } : {}), fromExtension: Boolean(event?.fromExtension) })
  })
  on('session_compact_failed', event => {
    state.compacting = false
    emit(state, { name: 'session_compact_failed', ...(event?.errorMessage ? { errorMessage: String(event.errorMessage) } : {}) })
  })

  // The first prompt must see the tools even when the user types before
  // discovery lands: wait for it here (bounded by the discovery timeout).
  // Tools registered during this hook reach this very turn, because Pi reads
  // the active tool loadout after before_agent_start returns. The server
  // instructions go in their own prompt section, which composes with other
  // extensions, where returning a whole systemPrompt would overwrite them.
  guard(() => pi.on('before_agent_start', async (event: any) => {
    // before_agent_start fires after every check that can refuse a prompt
    // (compaction, model, auth; agent-session.js prompt()), so our text has
    // started here. Settling now, instead of at message_start, keeps a slow
    // step between the two (the MCP discovery wait below, up to 10 s, or
    // pi's own pre-prompt compaction check) from turning a prompt that
    // started into `unknown` at the 5 s evidence deadline.
    guard(() => {
      const delivery = state.deliveries.find(d => d.text === event?.prompt)
      if (delivery) settle(state, delivery, 'started')
    })
    try {
      const discovery = await ensureMcp(state)
      const section = discovery && mcpInstructionsSection(discovery)
      if (section && event?.systemPromptOptions) {
        event.systemPromptOptions.sections = { ...(event.systemPromptOptions.sections ?? {}), 'agent-code-mcp': section }
      }
    } catch {
      // Rule 1: a failed discovery is a turn without Agent Code tools, never a
      // failed turn.
    }
    return undefined
  }))

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
