// Live tier for the whole package, driven through its public API exactly as
// Agent Code drives it: preparePiTerminalLaunch → the CALLER spawns pi in a
// PTY → new PiTerminalHeadless({ pty, launch }) → start().
//
//   PI_TERMINAL_HEADLESS_LIVE=1 PI_BINARY=/abs/path/to/pi NODE_PTY_PATH=<node-ABI node-pty> npm run test:live
//
// Sandboxed like the Stage 0 probe (temp HOME / PI_CODING_AGENT_DIR / git
// project outside any repo, faux model, offline). Asserts only on what the
// host would observe.

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { PiTerminalHeadless } from './PiTerminalHeadless.js'
import type { SemanticEvent } from './channels/types.js'
import { preparePiTerminalLaunch } from './launch/prepareLaunch.js'
import { readPiBranch } from './transcript/history.js'
import type { PiSessionRow } from './transcript/SessionFile.js'
import { waitUntil } from './testing/replay.js'

const LIVE = process.env.PI_TERMINAL_HEADLESS_LIVE === '1' && Boolean(process.env.PI_BINARY)
const BRIDGE = fileURLToPath(new URL('./bridge/extension.ts', import.meta.url))
const FAUX = fileURLToPath(new URL('../scripts/probe/faux.ts', import.meta.url))

type Pty = { pid: number; write(d: string): void; resize(c: number, r: number): void; kill(s?: string): void; onData(l: (d: string) => void): unknown; onExit(l: (e: { exitCode: number; signal?: number }) => void): { dispose(): void } }

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function spawnPi(options: { sessionId?: string; root?: string } = {}) {
  const require = createRequire(import.meta.url)
  const nodePty = require(process.env.NODE_PTY_PATH ?? 'node-pty') as { spawn(f: string, a: string[], o: object): Pty }
  const { Terminal } = require('@xterm/headless') as { Terminal: new (o: object) => { write(d: string): void; onData(l: (d: string) => void): void } }
  const root = options.root ?? mkdtempSync(join(realpathSync(tmpdir()), 'acpi-live-'))
  for (const d of ['home', 'agent', 'project']) mkdirSync(join(root, d), { recursive: true })
  if (!options.root) {
    execFileSync('git', ['init', '-q'], { cwd: join(root, 'project') })
    writeFileSync(join(root, 'project', 'README.md'), 'live\n')
  }
  const env = { PATH: process.env.PATH ?? '', HOME: join(root, 'home'), PI_CODING_AGENT_DIR: join(root, 'agent'), PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', TERM: 'xterm-256color' }
  const sessionId = options.sessionId ?? randomUUID()
  const launch = await preparePiTerminalLaunch({
    binary: process.env.PI_BINARY!,
    cwd: join(root, 'project'),
    env,
    sessionId,
    bridgeScriptPath: BRIDGE,
    homeDirectory: join(root, 'home'),
    extraArgs: ['--provider', 'faux', '--model', 'faux-1', '-e', FAUX],
  })
  // The caller owns the process (the package never spawns one).
  const pty = nodePty.spawn(launch.binary, launch.args, { name: 'xterm-256color', cols: 100, rows: 30, cwd: join(root, 'project'), env: launch.env })
  const term = new Terminal({ cols: 100, rows: 30, allowProposedApi: true })
  term.onData(d => pty.write(d))
  pty.onData(d => term.write(d))
  const headless = new PiTerminalHeadless({ pty, launch })
  const entries: PiSessionRow[] = []
  const semantic: SemanticEvent[] = []
  const live: Array<{ connected: boolean }> = []
  let exited = false
  headless.on('entry', ({ row }) => entries.push(row))
  headless.on('semantic', event => semantic.push(event))
  headless.on('live-state', state => live.push(state))
  headless.on('exit', () => { exited = true })
  await headless.start()
  cleanups.push(async () => {
    if (!exited) pty.kill('SIGKILL')
    await headless.stop()
    if (!options.root) rmSync(root, { recursive: true, force: true })
  })
  return { root, pty, headless, entries, semantic, live, sessionId, isExited: () => exited }
}

const completed = (semantic: SemanticEvent[]) => semantic.filter(e => e.type === 'turn_completed')

describe.skipIf(!LIVE)('PiTerminalHeadless with the real pi', () => {
  it('a fresh session: prompt via the bridge, answer committed before the turn completes, transcript = the file’s branch', async () => {
    const { headless, entries, semantic, live, sessionId } = await spawnPi()
    await waitUntil(() => live.some(s => s.connected), 20_000, 'bridge connected')
    await expect(headless.submitPrompt('please [tool]')).resolves.toEqual({ ok: true, outcome: 'started' })
    await waitUntil(() => completed(semantic).length === 1, 30_000, 'turn completed')
    expect((completed(semantic)[0] as { fullText: string }).fullText).toBe('Tool finished. Done.')
    const file = headless.getTranscriptFile()!
    expect(file).toMatch(new RegExp(`_${sessionId}\\.jsonl$`))
    const { rows } = await readPiBranch(file)
    expect(entries.map(r => r.id)).toEqual(rows.map(r => r.id))
    expect(headless.getActivity()).toMatchObject({ active: false, status: 'idle' })
  }, 60_000)

  it('resume after exit: history is not re-emitted, the new turn is', async () => {
    const first = await spawnPi()
    await waitUntil(() => first.live.some(s => s.connected), 20_000, 'bridge A')
    await first.headless.submitPrompt('remember this')
    await waitUntil(() => completed(first.semantic).length === 1, 30_000, 'turn A')
    first.pty.write('\x04') // Ctrl+D on an empty editor exits pi
    await waitUntil(first.isExited, 10_000, 'exit A')

    const second = await spawnPi({ sessionId: first.sessionId, root: first.root })
    await waitUntil(() => second.live.some(s => s.connected), 20_000, 'bridge B')
    await new Promise(r => setTimeout(r, 300))
    expect(second.entries).toEqual([])
    await second.headless.submitPrompt('and now')
    await waitUntil(() => completed(second.semantic).length === 1, 30_000, 'turn B')
    expect(second.entries.map(r => (r.message as { role?: string } | undefined)?.role)).toEqual(['user', 'assistant'])
  }, 90_000)
})
