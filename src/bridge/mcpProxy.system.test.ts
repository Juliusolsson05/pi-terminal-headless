import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BridgeServer } from '../live/BridgeServer.js'
import agentCodeBridge from './extension.js'
import { BRIDGE_SOCKET_ENV, BRIDGE_TOKEN_ENV, MCP_SERVERS_ENV, type BridgeEvent, type McpServerLaunchSpec } from './protocol.js'

// The bridge's MCP proxy against a local HTTP server speaking the wire shape
// of Agent Code's BuiltInMcpHttpHost: stateless, every POST answered as an SSE
// stream carrying the JSON-RPC reply, 202 for notifications, bearer required.
// (The app's system test runs the same client against the REAL host; the
// live tier runs it inside the real pi.) Pi is faked with exactly the
// ExtensionAPI surface the bridge uses.

const STATE_KEY = Symbol.for('agent-code.pi-bridge')
type Handler = (event: any, ctx: any) => unknown

class FakePi {
  handlers = new Map<string, Handler[]>()
  tools = new Map<string, any>()
  on(name: string, handler: Handler): () => void {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler])
    return () => undefined
  }
  registerTool(tool: any): void {
    if (typeof tool.parameters !== 'object' || tool.parameters === null) throw new Error('object schema required')
    this.tools.set(tool.name, tool)
  }
  sendUserMessage(): void {}
  fire(name: string, event: any, ctx: any): unknown[] {
    return (this.handlers.get(name) ?? []).map(handler => handler({ type: name, ...event }, ctx))
  }
}

const ctx = { isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getSessionId: () => 's', getSessionFile: () => '/s.jsonl', getLeafId: () => null } }

type Call = { method: string; authorization?: string; protocolVersion?: string }
let calls: Call[]
let mcp: Server
let mcpUrl: string
const BEARER = 'Bearer secret-token'

function body(req: IncomingMessage): Promise<any> {
  return new Promise(resolve => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => resolve(JSON.parse(data)))
  })
}

async function startMcp(): Promise<void> {
  mcp = createServer(async (req, res) => {
    const message = await body(req)
    calls.push({ method: message.method, authorization: req.headers.authorization, protocolVersion: req.headers['mcp-protocol-version'] as string | undefined })
    if (req.headers.authorization !== BEARER) { res.writeHead(401).end(); return }
    if (message.id === undefined) { res.writeHead(202).end(); return }
    const reply = (result: unknown) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`)
    }
    if (message.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'agent_code', version: '1' }, instructions: 'Use goal_set to record your goal.' })
    if (message.method === 'tools/list') {
      // Two pages, as a paginating server would send them.
      if (!message.params?.cursor) return reply({ tools: [{ name: 'echo', description: 'Echo text back.', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }], nextCursor: 'p2' })
      return reply({ tools: [{ name: 'fail', description: 'Always fails.', inputSchema: { type: 'object', properties: {} } }] })
    }
    if (message.method === 'tools/call') {
      if (message.params.name === 'echo') return reply({ content: [{ type: 'text', text: `echo: ${message.params.arguments.text}` }] })
      return reply({ content: [{ type: 'text', text: 'it broke' }], isError: true })
    }
    res.writeHead(400).end()
  })
  await new Promise<void>(resolve => mcp.listen(0, '127.0.0.1', resolve))
  const address = mcp.address() as { port: number }
  mcpUrl = `http://127.0.0.1:${address.port}/mcp/abc`
}

let dir: string
let server: BridgeServer
let events: BridgeEvent[]

function configure(specs: McpServerLaunchSpec[], values: Record<string, string>): void {
  process.env[MCP_SERVERS_ENV] = JSON.stringify(specs)
  Object.assign(process.env, values)
}

beforeEach(async () => {
  delete (globalThis as any)[STATE_KEY]
  calls = []
  await startMcp()
  dir = mkdtempSync('/tmp/acpi-m-')
  const token = randomBytes(16).toString('hex')
  process.env[BRIDGE_SOCKET_ENV] = join(dir, 's')
  process.env[BRIDGE_TOKEN_ENV] = token
  server = new BridgeServer(join(dir, 's'), token)
  events = []
  server.on('event', event => events.push(event))
  await server.listen()
})

afterEach(async () => {
  await server.close()
  await new Promise(resolve => mcp.close(resolve))
  delete (globalThis as any)[STATE_KEY]
  for (const key of [BRIDGE_SOCKET_ENV, BRIDGE_TOKEN_ENV, MCP_SERVERS_ENV, 'AGENT_CODE_MCP_0_0']) delete process.env[key]
  rmSync(dir, { recursive: true, force: true })
})

async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise(r => setTimeout(r, 10))
  }
}

describe('Agent Code MCP tools inside Pi', () => {
  it('discovers every page of tools at session start and registers them under Claude-style names; the bearer never stays in the env', async () => {
    configure([{ name: 'agent_code', url: '', headerEnv: { Authorization: 'AGENT_CODE_MCP_0_0' } }].map(spec => ({ ...spec, url: mcpUrl })), { AGENT_CODE_MCP_0_0: BEARER })
    const pi = new FakePi()
    agentCodeBridge(pi)
    // Hygiene: the model's bash tool inherits this env.
    expect(process.env[MCP_SERVERS_ENV]).toBeUndefined()
    expect(process.env.AGENT_CODE_MCP_0_0).toBeUndefined()
    // Pi's rule: the factory opens nothing.
    await new Promise(r => setTimeout(r, 30))
    expect(calls).toEqual([])

    pi.fire('session_start', { reason: 'startup' }, ctx)
    await until(() => pi.tools.size === 2)
    expect([...pi.tools.keys()]).toEqual(['mcp__agent_code__echo', 'mcp__agent_code__fail'])
    expect(pi.tools.get('mcp__agent_code__echo').parameters).toEqual({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false })
    expect(calls.map(call => call.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list'])
    expect(calls.every(call => call.authorization === BEARER)).toBe(true)
    // After initialize, every request carries the version the server chose.
    expect(calls.slice(1).every(call => call.protocolVersion === '2025-03-26')).toBe(true)
    await until(() => events.some(event => event.name === 'mcp_status'))
    expect(events.find(event => event.name === 'mcp_status')).toEqual({ name: 'mcp_status', servers: [{ name: 'agent_code', tools: 2 }] })
  })

  it('a tool call reaches the server with its arguments; an MCP isError becomes a thrown (error) tool result', async () => {
    configure([{ name: 'agent_code', url: mcpUrl, headerEnv: { Authorization: 'AGENT_CODE_MCP_0_0' } }], { AGENT_CODE_MCP_0_0: BEARER })
    const pi = new FakePi()
    agentCodeBridge(pi)
    pi.fire('session_start', { reason: 'startup' }, ctx)
    await until(() => pi.tools.size === 2)
    await expect(pi.tools.get('mcp__agent_code__echo').execute('call-1', { text: 'hi' }, undefined)).resolves.toEqual({
      content: [{ type: 'text', text: 'echo: hi' }], details: { server: 'agent_code', tool: 'echo' },
    })
    await expect(pi.tools.get('mcp__agent_code__fail').execute('call-2', {}, undefined)).rejects.toThrow('it broke')
  })

  it('the first prompt waits for discovery and carries the server instructions in their own prompt section', async () => {
    configure([{ name: 'agent_code', url: mcpUrl, headerEnv: { Authorization: 'AGENT_CODE_MCP_0_0' } }], { AGENT_CODE_MCP_0_0: BEARER })
    const pi = new FakePi()
    agentCodeBridge(pi)
    pi.fire('session_start', { reason: 'startup' }, ctx)
    // Fired immediately, before discovery can have landed.
    const event = { prompt: 'hi', systemPrompt: 'base', systemPromptOptions: { sections: { other: 'kept' } } }
    await Promise.all(pi.fire('before_agent_start', event, ctx))
    expect(pi.tools.size).toBe(2)
    expect(event.systemPromptOptions.sections).toEqual({
      other: 'kept',
      'agent-code-mcp': '# MCP Server Instructions\n\nThe following MCP servers have provided instructions for how to use their tools and resources:\n\n## agent_code\nUse goal_set to record your goal.',
    })
  })

  it('a rebuilt runtime (/new, /resume, /fork, /reload) gets the tools without a second discovery', async () => {
    configure([{ name: 'agent_code', url: mcpUrl, headerEnv: { Authorization: 'AGENT_CODE_MCP_0_0' } }], { AGENT_CODE_MCP_0_0: BEARER })
    const first = new FakePi()
    agentCodeBridge(first)
    first.fire('session_start', { reason: 'startup' }, ctx)
    await until(() => first.tools.size === 2)
    const discoveryCalls = calls.length
    const second = new FakePi()
    agentCodeBridge(second)
    expect([...second.tools.keys()]).toEqual(['mcp__agent_code__echo', 'mcp__agent_code__fail'])
    second.fire('session_start', { reason: 'new' }, ctx)
    await new Promise(r => setTimeout(r, 30))
    expect(calls.length).toBe(discoveryCalls)
  })

  it('an unreachable or refusing server is reported, and a prompt still runs, without tools', async () => {
    configure([
      { name: 'down', url: 'http://127.0.0.1:1/mcp', headerEnv: {} },
      { name: 'agent_code', url: mcpUrl, headerEnv: {} }, // no bearer: 401
    ], {})
    const pi = new FakePi()
    agentCodeBridge(pi)
    pi.fire('session_start', { reason: 'startup' }, ctx)
    const event = { prompt: 'hi', systemPrompt: 'base', systemPromptOptions: {} as Record<string, unknown> }
    await Promise.all(pi.fire('before_agent_start', event, ctx))
    expect(pi.tools.size).toBe(0)
    expect(event.systemPromptOptions.sections).toBeUndefined()
    await until(() => events.some(e => e.name === 'mcp_status'))
    const status = (events.find(e => e.name === 'mcp_status') as Extract<BridgeEvent, { name: 'mcp_status' }>).servers
    expect(status.map(s => s.name).sort()).toEqual(['agent_code', 'down'])
    expect(status.every(s => s.tools === 0 && typeof s.error === 'string')).toBe(true)
    expect(status.find(s => s.name === 'agent_code')!.error).toContain('401')
  })
})
