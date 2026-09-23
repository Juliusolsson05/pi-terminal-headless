import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BridgeServer, BridgeRequestError } from '../live/BridgeServer.js'
import agentCodeBridge from './extension.js'
import { BRIDGE_PROTOCOL_VERSION, BRIDGE_SOCKET_ENV, BRIDGE_TOKEN_ENV, type BridgeEvent } from './protocol.js'

// The real extension module against the real host server over a real Unix
// socket. Pi itself is faked here (the live tier loads the extension into the
// real pi): the fake exposes exactly the ExtensionAPI surface the bridge uses
// and fires handlers with payloads shaped like the recorded Pi 0.87.1 events.

const STATE_KEY = Symbol.for('agent-code.pi-bridge')
type Handler = (event: any, ctx: any) => unknown

class FakePi {
  handlers = new Map<string, Handler[]>()
  sent: Array<{ text: string; options: unknown }> = []
  sendImpl: (text: string, options: unknown) => void = () => undefined
  on(name: string, handler: Handler): () => void {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler])
    return () => undefined
  }
  sendUserMessage(text: string, options: unknown): void {
    this.sent.push({ text, options })
    this.sendImpl(text, options)
  }
  fire(name: string, event: any, ctx: any): unknown[] {
    return (this.handlers.get(name) ?? []).map(handler => handler({ type: name, ...event }, ctx))
  }
}

function fakeCtx(overrides: Partial<{ idle: boolean; pending: boolean; sessionId: string; file: string; leafId: string | null }> = {}) {
  const state = { idle: true, pending: false, sessionId: 'sess-1', file: '/sandbox/s.jsonl', leafId: null as string | null, aborted: 0, ...overrides }
  return {
    state,
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pending,
    abort: () => { state.aborted += 1 },
    sessionManager: { getSessionId: () => state.sessionId, getSessionFile: () => state.file, getLeafId: () => state.leafId },
  }
}

let dir: string
let socketPath: string
let token: string
let server: BridgeServer
let events: BridgeEvent[]

async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise(r => setTimeout(r, 10))
  }
}

beforeEach(async () => {
  delete (globalThis as any)[STATE_KEY]
  // Short path: macOS sun_path is 104 bytes (Stage 0).
  dir = mkdtempSync('/tmp/acpi-t-')
  socketPath = join(dir, 's')
  token = randomBytes(16).toString('hex')
  process.env[BRIDGE_SOCKET_ENV] = socketPath
  process.env[BRIDGE_TOKEN_ENV] = token
  server = new BridgeServer(socketPath, token)
  events = []
  server.on('event', event => events.push(event))
  await server.listen()
})

afterEach(async () => {
  await server.close()
  delete (globalThis as any)[STATE_KEY]
  delete process.env[BRIDGE_SOCKET_ENV]
  delete process.env[BRIDGE_TOKEN_ENV]
  rmSync(dir, { recursive: true, force: true })
})

async function started(pi: FakePi, ctx = fakeCtx()) {
  agentCodeBridge(pi)
  pi.fire('session_start', { reason: 'startup' }, ctx)
  await until(() => server.isConnected() && events.some(e => e.name === 'session_start'))
  return ctx
}

describe('bridge extension ↔ host', () => {
  it('opens nothing in the factory; connects at session_start and authenticates with the token', async () => {
    const pi = new FakePi()
    agentCodeBridge(pi)
    await new Promise(r => setTimeout(r, 50))
    expect(server.isConnected()).toBe(false) // Pi's rule: no sockets in the factory
    pi.fire('session_start', { reason: 'startup' }, fakeCtx({ leafId: 'abc' }))
    await until(() => events.length > 0)
    expect(events[0]).toEqual({ name: 'session_start', reason: 'startup', idle: true, sessionId: 'sess-1', file: '/sandbox/s.jsonl', leafId: 'abc' })
  })

  it('removes the socket and token from the env the model’s tools inherit', () => {
    agentCodeBridge(new FakePi())
    expect(process.env[BRIDGE_SOCKET_ENV]).toBeUndefined()
    expect(process.env[BRIDGE_TOKEN_ENV]).toBeUndefined()
  })

  it('project_trust connects early, reports the pending prompt, and leaves the decision to the user', async () => {
    const pi = new FakePi()
    agentCodeBridge(pi)
    const [result] = pi.fire('project_trust', { cwd: '/p' }, undefined)
    expect(result).toEqual({ trusted: 'undecided' })
    await until(() => events.some(e => e.name === 'project_trust'))
  })

  it('maps turn_end to its entry ids and stop reason (the doorbell), and phases on change only', async () => {
    const pi = new FakePi()
    const ctx = await started(pi)
    pi.fire('agent_start', {}, ctx)
    for (const type of ['thinking_start', 'thinking_delta', 'thinking_delta', 'text_delta', 'text_delta', 'toolcall_start']) {
      pi.fire('message_update', { assistantMessageEvent: { type } }, ctx)
    }
    pi.fire('turn_end', { turnIndex: 0, messageEntryId: 'a1', toolResultEntryIds: ['t1'], message: { role: 'assistant', stopReason: 'toolUse' } }, ctx)
    ctx.state.leafId = 'a2'
    pi.fire('agent_settled', {}, ctx)
    await until(() => events.some(e => e.name === 'agent_settled'))
    expect(events.filter(e => e.name === 'phase').map(e => (e as { phase: string }).phase)).toEqual(['thinking', 'responding', 'tool'])
    expect(events.find(e => e.name === 'turn_end')).toEqual({ name: 'turn_end', turnIndex: 0, messageEntryId: 'a1', toolResultEntryIds: ['t1'], stopReason: 'toolUse' })
    expect(events.find(e => e.name === 'agent_settled')).toEqual({ name: 'agent_settled', leafId: 'a2' })
  })

  it('prompt while idle: always sent as followUp, acknowledged "started" only when Pi starts it', async () => {
    const pi = new FakePi()
    const ctx = await started(pi)
    pi.sendImpl = text => setTimeout(() => {
      pi.fire('input', { text, source: 'extension' }, ctx)
      pi.fire('message_start', { message: { role: 'user', content: [{ type: 'text', text }] } }, ctx)
    }, 5)
    await expect(server.prompt('hello pi')).resolves.toEqual({ outcome: 'started' })
    expect(pi.sent).toEqual([{ text: 'hello pi', options: { deliverAs: 'followUp' } }])
  })

  it('prompt while busy: acknowledged "queued" once Pi’s queue holds it', async () => {
    const pi = new FakePi()
    const ctx = await started(pi, fakeCtx({ idle: false }))
    pi.sendImpl = text => setTimeout(() => {
      pi.fire('input', { text, source: 'extension', streamingBehavior: 'followUp' }, ctx)
      setTimeout(() => { ctx.state.pending = true }, 30)
    }, 5)
    await expect(server.prompt('later')).resolves.toEqual({ outcome: 'queued' })
  })

  it('prompt Pi silently drops (the Stage 0 H5 case): "unknown" after the evidence deadline, never ok', async () => {
    const pi = new FakePi()
    await started(pi, fakeCtx({ idle: false }))
    await expect(server.prompt('lost', 10_000)).resolves.toEqual({ outcome: 'unknown' })
  }, 10_000)

  it('prompt against a replaced runtime (sendUserMessage throws "stale") is rejected, not acknowledged', async () => {
    const pi = new FakePi()
    await started(pi)
    pi.sendImpl = () => { throw new Error('This extension ctx is stale after session replacement') }
    await expect(server.prompt('x')).rejects.toMatchObject({ code: 'rejected' })
  })

  it('a re-run factory (Pi rebuilds the runtime on /new, /resume, /fork, /reload) keeps one link and uses the newest pi', async () => {
    const first = new FakePi()
    await started(first)
    let connections = 1
    server.on('connected', () => { connections += 1 })
    const second = new FakePi()
    agentCodeBridge(second)
    second.fire('session_start', { reason: 'new' }, fakeCtx({ sessionId: 'sess-2', file: '/sandbox/s2.jsonl' }))
    await until(() => events.filter(e => e.name === 'session_start').length === 2)
    expect(connections).toBe(1)
    second.sendImpl = text => second.fire('message_start', { message: { role: 'user', content: text } }, fakeCtx())
    await expect(server.prompt('to the new runtime')).resolves.toEqual({ outcome: 'started' })
    expect(first.sent).toEqual([])
    expect(second.sent).toHaveLength(1)
  })

  it('abort and state requests act on the latest context', async () => {
    const pi = new FakePi()
    const ctx = await started(pi, fakeCtx({ idle: false, pending: true, leafId: 'l9' }))
    await expect(server.state()).resolves.toEqual({ idle: false, pending: true, sessionId: 'sess-1', file: '/sandbox/s.jsonl', leafId: 'l9' })
    await expect(server.abort()).resolves.toEqual({ aborted: true })
    expect(ctx.state.aborted).toBe(1)
  })

  it('a throwing Pi context never escapes a handler (rule 1)', async () => {
    const pi = new FakePi()
    await started(pi)
    const hostile = { isIdle: () => { throw new Error('boom') }, sessionManager: { getSessionFile: () => { throw new Error('boom') } } }
    expect(() => pi.fire('session_start', { reason: 'x' }, hostile)).not.toThrow()
    expect(() => pi.fire('input', { text: 'x', source: 'extension' }, hostile)).not.toThrow()
    expect(() => pi.fire('turn_end', null, hostile)).not.toThrow()
  })

  it('no host listening: handlers and reconnects never throw (a dead host must not kill pi)', async () => {
    await server.close()
    const pi = new FakePi()
    agentCodeBridge(pi)
    expect(() => pi.fire('session_start', { reason: 'startup' }, fakeCtx())).not.toThrow()
    expect(() => pi.fire('agent_start', {}, fakeCtx())).not.toThrow()
    await new Promise(r => setTimeout(r, 400)) // first reconnect attempts fire and fail quietly
  })

  it('without the env (someone ran pi -e by hand) the extension is inert', () => {
    delete process.env[BRIDGE_SOCKET_ENV]
    delete process.env[BRIDGE_TOKEN_ENV]
    const pi = new FakePi()
    agentCodeBridge(pi)
    expect(pi.handlers.size).toBe(0)
  })
})

describe('host admission', () => {
  it('refuses a peer without the token, and a prompt with no bridge fails as no-live-channel', async () => {
    const refused: string[] = []
    server.on('refused', ({ reason }) => refused.push(reason))
    const socket = connect(socketPath)
    socket.on('error', () => undefined)
    await new Promise<void>(resolve => socket.on('connect', () => resolve()))
    socket.write(JSON.stringify({ t: 'hello', token: 'wrong', protocol: BRIDGE_PROTOCOL_VERSION, pid: 1 }) + '\n')
    await until(() => refused.length === 1)
    expect(refused).toEqual(['bad token'])
    await expect(server.prompt('x')).rejects.toBeInstanceOf(BridgeRequestError)
    await expect(server.prompt('x')).rejects.toMatchObject({ code: 'no-live-channel' })
  })

  it('the extension duplicates the protocol constants correctly (it cannot import them at runtime)', () => {
    const source = readFileSync(new URL('./extension.ts', import.meta.url), 'utf8')
    expect(source).toContain(`const BRIDGE_PROTOCOL_VERSION = ${BRIDGE_PROTOCOL_VERSION}`)
    expect(source).toContain(`const BRIDGE_SOCKET_ENV = '${BRIDGE_SOCKET_ENV}'`)
    expect(source).toContain(`const BRIDGE_TOKEN_ENV = '${BRIDGE_TOKEN_ENV}'`)
    // Rule 3: no runtime import other than node builtins.
    const runtimeImports = [...source.matchAll(/^import (?!type )[^\n]* from '([^']+)'/gm)].map(m => m[1])
    expect(runtimeImports.every(specifier => specifier!.startsWith('node:'))).toBe(true)
  })
})
