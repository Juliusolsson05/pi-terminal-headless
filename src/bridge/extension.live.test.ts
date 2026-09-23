// Live tier: the REAL bridge extension loaded by the REAL pi TUI, talking to
// the real BridgeServer. Opt-in, because it runs the pinned Pi binary:
//
//   PI_TERMINAL_HEADLESS_LIVE=1 PI_BINARY=/abs/path/to/pi NODE_PTY_PATH=<node-ABI node-pty> npm run test:live
//
// Sandbox exactly as the Stage 0 probe: temp HOME / PI_CODING_AGENT_DIR / git
// project outside any repo, the scripted faux model, offline. What only this
// tier can prove: jiti loads the file as shipped (type-only imports erased,
// no runtime imports), the singleton survives Pi's runtime rebuild on /new,
// sendUserMessage acknowledgement works against Pi's real queue, and killing
// the host's socket leaves the user's pi running.

import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { BridgeServer } from '../live/BridgeServer.js'
import type { BridgeEvent } from './protocol.js'

const LIVE = process.env.PI_TERMINAL_HEADLESS_LIVE === '1' && Boolean(process.env.PI_BINARY)
const HERE = fileURLToPath(new URL('.', import.meta.url))
const FAUX = fileURLToPath(new URL('../../scripts/probe/faux.ts', import.meta.url))

type Pty = { pid: number; write(d: string): void; kill(s?: string): void; onData(l: (d: string) => void): unknown; onExit(l: (e: { exitCode: number }) => void): unknown }

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function until(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`)
    await new Promise(r => setTimeout(r, 20))
  }
}

async function launch(settings?: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
  const require = createRequire(import.meta.url)
  const pty = require(process.env.NODE_PTY_PATH ?? 'node-pty') as { spawn(f: string, a: string[], o: object): Pty }
  const { Terminal } = require('@xterm/headless') as { Terminal: new (o: object) => { write(d: string): void; onData(l: (d: string) => void): void } }
  const root = join(realpathSync(tmpdir()), `acpi-live-${randomBytes(3).toString('hex')}`)
  const socketDir = mkdtempSync('/tmp/acpi-')
  const socketPath = join(socketDir, 's')
  const token = randomBytes(24).toString('base64url')
  for (const d of ['home', 'agent', 'project']) mkdirSync(join(root, d), { recursive: true })
  if (settings) writeFileSync(join(root, 'agent', 'settings.json'), JSON.stringify(settings) + '\n')
  execFileSync('git', ['init', '-q'], { cwd: join(root, 'project') })
  // Load the bridge the way Agent Code ships it: ONE file copied away from
  // its package (out/main/runtime/pi/bridge.ts), with no protocol.ts beside
  // it — proving the type-only import is erased and nothing else is needed.
  const bridgeFile = join(root, 'bridge.ts')
  copyFileSync(join(HERE, 'extension.ts'), bridgeFile)
  writeFileSync(join(root, 'project', 'README.md'), 'live\n')
  const server = new BridgeServer(socketPath, token)
  const events: BridgeEvent[] = []
  server.on('event', e => events.push(e))
  await server.listen()
  const sessionId = randomUUID()
  const term = new Terminal({ cols: 100, rows: 30, allowProposedApi: true })
  const child = pty.spawn(process.env.PI_BINARY!, ['--provider', 'faux', '--model', 'faux-1', '-e', FAUX, '-e', bridgeFile, '--session-id', sessionId], {
    name: 'xterm-256color', cols: 100, rows: 30, cwd: join(root, 'project'),
    env: {
      PATH: process.env.PATH, HOME: join(root, 'home'), PI_CODING_AGENT_DIR: join(root, 'agent'), PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
      TERM: 'xterm-256color', AGENT_CODE_PI_BRIDGE_SOCKET: socketPath, AGENT_CODE_PI_BRIDGE_TOKEN: token,
      ...extraEnv,
    },
  })
  let exited = false
  let output = ''
  term.onData(d => child.write(d))
  child.onData(d => { output += d; term.write(d) })
  child.onExit(() => { exited = true })
  cleanups.push(async () => {
    if (!exited) child.kill('SIGKILL')
    await server.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(socketDir, { recursive: true, force: true })
  })
  return { child, server, events, sessionId, isExited: () => exited, output: () => output }
}

describe.skipIf(!LIVE)('bridge extension inside the real pi', () => {
  it('connects, reports the launched session, and delivers idle and busy prompts with honest outcomes', async () => {
    const { server, events, sessionId } = await launch()
    await until(() => events.some(e => e.name === 'session_start'), 'session_start')
    const start = events.find(e => e.name === 'session_start') as Extract<BridgeEvent, { name: 'session_start' }>
    expect(start.sessionId).toBe(sessionId)
    expect(start.file).toMatch(new RegExp(`_${sessionId}\\.jsonl$`))

    await expect(server.prompt('first [probe:live-idle]')).resolves.toEqual({ outcome: 'started' })
    await until(() => events.filter(e => e.name === 'agent_settled').length === 1, 'first settle')

    await expect(server.prompt('long [slow] [probe:live-busy-a]')).resolves.toEqual({ outcome: 'started' })
    await until(() => events.some(e => e.name === 'phase'), 'streaming')
    await expect(server.prompt('queued behind [probe:live-busy-b]')).resolves.toEqual({ outcome: 'queued' })
    await until(() => events.filter(e => e.name === 'agent_settled').length === 2, 'second settle', 30_000)
    // The queued prompt ran inside the same span (H4): one more settle only.
    expect(events.filter(e => e.name === 'agent_start')).toHaveLength(2)
  }, 60_000)

  it('survives /new (Pi rebuilds the extension runtime) and prompts reach the new session', async () => {
    const { child, server, events } = await launch()
    await until(() => events.some(e => e.name === 'session_start'), 'session_start')
    await expect(server.prompt('in A')).resolves.toEqual({ outcome: 'started' })
    await until(() => events.some(e => e.name === 'agent_settled'), 'settle A')
    child.write('/new')
    child.write('\r')
    await until(() => events.filter(e => e.name === 'session_start').length === 2, 'second session_start')
    const second = events.filter(e => e.name === 'session_start')[1] as Extract<BridgeEvent, { name: 'session_start' }>
    expect(second.reason).toBe('new')
    await expect(server.prompt('in B')).resolves.toEqual({ outcome: 'started' })
    await until(() => events.filter(e => e.name === 'agent_settled').length === 2, 'settle B')
    expect(server.isConnected()).toBe(true)
  }, 60_000)

  it('a delivered /compact runs Pi’s compaction (never reaches the model as text) and lands a compaction row', async () => {
    // keepRecentTokens 1, as in the Stage 0 compaction scenario: faux replies
    // are a few tokens, and Pi refuses to compact a session "too small".
    const { server, events } = await launch({ compaction: { keepRecentTokens: 1 } })
    await until(() => events.some(e => e.name === 'session_start'), 'session_start')
    const start = events.find(e => e.name === 'session_start') as Extract<BridgeEvent, { name: 'session_start' }>
    for (const text of ['one [probe:lc1]', 'two [probe:lc2]']) {
      const settled = events.filter(e => e.name === 'agent_settled').length
      await server.prompt(text)
      await until(() => events.filter(e => e.name === 'agent_settled').length > settled, 'settle')
    }
    await expect(server.prompt('/compact')).resolves.toEqual({ outcome: 'started' })
    await until(() => events.some(e => e.name === 'session_compact' || e.name === 'session_compact_failed'), 'compaction outcome', 30_000)
    expect(events.find(e => e.name === 'session_compact_failed')).toBeUndefined()
    const rows = readFileSync(start.file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(rows.some(row => row.type === 'compaction')).toBe(true)
    expect(rows.some(row => row.message?.role === 'user' && JSON.stringify(row.message.content).includes('/compact'))).toBe(false)
  }, 60_000)

  it('Agent Code MCP tools reach the model inside the real pi, with their server instructions, and run against the server', async () => {
    // A local MCP endpoint in the built-in host's wire shape (stateless, SSE
    // replies, bearer required). The app's system test covers the real host.
    const calls: Array<{ method: string; params: any }> = []
    const mcp = createServer((req, res) => {
      let data = ''
      req.on('data', chunk => { data += chunk })
      req.on('end', () => {
        const message = JSON.parse(data)
        calls.push({ method: message.method, params: message.params })
        if (req.headers.authorization !== 'Bearer live-secret') { res.writeHead(401).end(); return }
        if (message.id === undefined) { res.writeHead(202).end(); return }
        const result = message.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agent_code', version: '1' }, instructions: 'Echo is available.' }
          : message.method === 'tools/list'
            ? { tools: [{ name: 'echo', description: 'Echo text back.', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }] }
            : { content: [{ type: 'text', text: `echo: ${message.params?.arguments?.text}` }] }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`)
      })
    })
    await new Promise<void>(resolve => mcp.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>(resolve => mcp.close(() => resolve())))
    const url = `http://127.0.0.1:${(mcp.address() as { port: number }).port}/mcp/live`
    const { server, events } = await launch(undefined, {
      AGENT_CODE_PI_MCP_SERVERS: JSON.stringify([{ name: 'agent_code', url, headerEnv: { Authorization: 'AGENT_CODE_MCP_0_0' } }]),
      AGENT_CODE_MCP_0_0: 'Bearer live-secret',
    })
    await until(() => events.some(e => e.name === 'session_start'), 'session_start')
    await expect(server.prompt('use the tool [mcp]')).resolves.toEqual({ outcome: 'started' })
    await until(() => events.some(e => e.name === 'agent_settled'), 'settle', 30_000)
    expect(events.find(e => e.name === 'mcp_status')).toEqual({ name: 'mcp_status', servers: [{ name: 'agent_code', tools: 1 }] })
    // The model saw the tool and the instructions section, and the call ran.
    const call = calls.find(c => c.method === 'tools/call')
    expect(call?.params).toEqual({ name: 'echo', arguments: { text: 'tool:true instructions:true' } })
    const start = events.find(e => e.name === 'session_start') as Extract<BridgeEvent, { name: 'session_start' }>
    const rows = readFileSync(start.file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const result = rows.find(row => row.message?.role === 'toolResult')
    expect(result?.message).toMatchObject({ toolName: 'mcp__agent_code__echo', isError: false, content: [{ type: 'text', text: 'echo: tool:true instructions:true' }] })
  }, 60_000)

  it('abort stops a streaming reply; closing the host socket leaves pi running', async () => {
    const { server, events, isExited, child } = await launch()
    await until(() => events.some(e => e.name === 'session_start'), 'session_start')
    await server.prompt('long [slow]')
    await until(() => events.some(e => e.name === 'phase'), 'streaming')
    await expect(server.abort()).resolves.toEqual({ aborted: true })
    await until(() => events.some(e => e.name === 'turn_end' && (e as { stopReason?: string }).stopReason === 'aborted'), 'aborted turn')
    await server.close()
    await new Promise(r => setTimeout(r, 1500)) // the bridge's reconnect attempts fail quietly
    expect(isExited()).toBe(false)
    // pi still answers the keyboard: a typed prompt runs (visible on screen).
    child.write('still alive\r')
    await new Promise(r => setTimeout(r, 1500))
    expect(isExited()).toBe(false)
  }, 60_000)
})
