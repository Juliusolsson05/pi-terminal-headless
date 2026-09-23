// Stage 0 live probe: record what the native Pi TUI actually does when it is
// launched the way this package will launch it.
//
// Usage:
//   NODE_PTY_PATH=/abs/path/to/node_modules/node-pty \
//   npm run probe:live -- --binary /abs/path/to/pi [--scenario plain,tool,...] [--out testing/fixtures/live]
//
// WHY a probe instead of trusting Pi's source: the durable reader, the live
// projector and the sequencer all key on WHEN Pi writes a row relative to the
// extension events it fires, and on which events fire in which order. Source
// reading suggested answers; only recordings of the real pinned binary make
// them test fixtures (spec §8, hypotheses H1–H10).
//
// SAFETY: every run uses a throwaway HOME, PI_CODING_AGENT_DIR and git
// project under the OS temp directory, the scripted faux model from scripts/probe/faux.ts,
// PI_OFFLINE=1 and PI_SKIP_VERSION_CHECK=1. No user config, auth, skills or
// sessions are read, and nothing leaves the machine.
//
// The terminal on the other side of the PTY is @xterm/headless when it can be
// resolved (it is in Agent Code's node_modules): Pi queries DA1 and the Kitty
// keyboard protocol at startup, and Agent Code's panes are xterm.js, so using
// the same emulator is what makes hypothesis H8 answerable. Without it, the
// probe answers DA1 by hand and records that it did.

import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { createServer, type Socket } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type PtyLike = {
  pid: number
  write(data: string): void
  kill(signal?: string): void
  resize(cols: number, rows: number): void
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): { dispose(): void }
}
type PtyModule = { spawn(file: string, args: string[], opts: Record<string, unknown>): PtyLike }

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..')
const COLS = 100
const ROWS = 30

const require = createRequire(import.meta.url)
const ptyModule = require(process.env.NODE_PTY_PATH ?? 'node-pty') as PtyModule
let XtermTerminal: (new (opts: Record<string, unknown>) => any) | undefined
try {
  XtermTerminal = (require('@xterm/headless') as { Terminal: new (opts: Record<string, unknown>) => any }).Terminal
} catch {
  XtermTerminal = undefined
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// One recording session

type Step = { t: number; action: string; detail?: unknown }

class Recording {
  readonly root: string
  readonly home: string
  readonly agentDir: string
  readonly project: string
  readonly eventsFile: string
  readonly socketDir: string
  readonly socketPath: string
  readonly t0 = Date.now()
  readonly steps: Step[] = []
  readonly notes: string[] = []
  readonly growth: Array<{ t: number; file: string; bytes: number }> = []
  readonly ptyChunks: Array<{ t: number; len: number; process: number }> = []
  da1HandAnswered = 0
  private peers: Socket[] = []
  private server = createServer(socket => {
    this.peers.push(socket)
    socket.on('error', () => undefined)
  })
  private lastSizes = new Map<string, number>()
  private growthTimer: NodeJS.Timeout | undefined
  term: any
  pty: PtyLike | undefined
  processIndex = 0
  exits: Array<{ t: number; process: number; exitCode: number; signal?: number }> = []

  constructor(readonly scenario: string, readonly binary: string) {
    // WHY outside the repository: Pi walks every ancestor of the cwd for
    // AGENTS.md/CLAUDE.md and project-local resources. A sandbox under this
    // package inherited Agent Code's AGENTS.md and a project-trust prompt
    // that swallowed the first typed prompt (first probe run, 2026-09-22).
    this.root = join(realpathSync(tmpdir()), `acpi-probe-${scenario}-${randomBytes(3).toString('hex')}`)
    this.home = join(this.root, 'home')
    this.agentDir = join(this.root, 'agent')
    this.project = join(this.root, 'project')
    this.eventsFile = join(this.root, 'events.jsonl')
    // WHY /tmp and a short name: macOS sun_path is 104 bytes and the sandbox
    // path under the package is far longer (the same constraint the
    // production launch helper has to respect).
    this.socketDir = join('/tmp', `acpi-probe-${randomBytes(3).toString('hex')}`)
    this.socketPath = join(this.socketDir, 's')
    for (const dir of [this.home, this.agentDir, this.project, this.socketDir]) mkdirSync(dir, { recursive: true, mode: 0o700 })
    execFileSync('git', ['init', '-q'], { cwd: this.project })
    writeFileSync(join(this.project, 'README.md'), 'probe project\n')
  }

  now(): number {
    return Date.now() - this.t0
  }

  step(action: string, detail?: unknown): void {
    this.steps.push({ t: this.now(), action, ...(detail === undefined ? {} : { detail }) })
  }

  async listen(): Promise<void> {
    await new Promise<void>((ok, fail) => {
      this.server.once('error', fail)
      this.server.listen(this.socketPath, () => ok())
    })
  }

  sessionsDir(): string {
    return join(this.agentDir, 'sessions')
  }

  sessionFiles(): string[] {
    const dir = this.sessionsDir()
    if (!existsSync(dir)) return []
    const out: string[] = []
    for (const sub of readdirSync(dir)) {
      const full = join(dir, sub)
      if (!statSync(full).isDirectory()) continue
      for (const name of readdirSync(full)) if (name.endsWith('.jsonl')) out.push(join(full, name))
    }
    return out.sort()
  }

  startGrowthPoll(): void {
    // 10 ms stat polling: coarse, but the question is ordering relative to
    // events recorded INSIDE pi (which carry their own fileBytes), so this
    // series is corroboration, not the primary evidence.
    this.growthTimer = setInterval(() => {
      for (const file of this.sessionFiles()) {
        let bytes = -1
        try { bytes = statSync(file).size } catch { /* raced with creation */ }
        if (this.lastSizes.get(file) !== bytes) {
          this.lastSizes.set(file, bytes)
          this.growth.push({ t: this.now(), file, bytes })
        }
      }
    }, 10)
  }

  spawn(args: string[], extraEnv: Record<string, string> = {}): PtyLike {
    this.processIndex += 1
    const index = this.processIndex
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: this.home,
      PI_CODING_AGENT_DIR: this.agentDir,
      PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
      PI_PROBE_EVENTS: this.eventsFile,
      PI_PROBE_SOCKET: this.socketPath,
      PI_PROBE_T0: String(this.t0),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: 'en_US.UTF-8',
      ...extraEnv,
    }
    const fullArgs = [
      '--provider', 'faux', '--model', 'faux-1',
      '-e', join(HERE, 'probe', 'faux.ts'),
      '-e', join(HERE, 'probe', 'recorder.ts'),
      ...args,
    ]
    this.step('spawn', { process: index, args: fullArgs.map(a => a.replace(HERE, '<scripts>')) })
    const pty = ptyModule.spawn(this.binary, fullArgs, { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: this.project, env })
    this.pty = pty
    if (XtermTerminal) {
      this.term = new XtermTerminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 2000 })
      // The emulator's replies (DA1, DSR, ...) go back to pi exactly as
      // xterm.js in an Agent Code pane would send them.
      this.term.onData((data: string) => pty.write(data))
    }
    pty.onData(data => {
      this.ptyChunks.push({ t: this.now(), len: data.length, process: index })
      if (this.term) this.term.write(data)
      else if (data.includes('\x1b[c')) {
        this.da1HandAnswered += 1
        pty.write('\x1b[?62;c')
      }
    })
    pty.onExit(e => this.exits.push({ t: this.now(), process: index, exitCode: e.exitCode, signal: e.signal }))
    return pty
  }

  type(text: string): void {
    this.step('type', { text })
    this.pty?.write(text)
  }

  key(name: 'enter' | 'esc' | 'ctrl-c' | 'ctrl-d' | 'alt-enter', raw: string): void {
    this.step('key', { name })
    this.pty?.write(raw)
  }

  // Bracketed paste + Enter: the delivery the host's own composer uses.
  paste(text: string): void {
    this.step('paste', { text })
    this.pty?.write(`\x1b[200~${text}\x1b[201~`)
  }

  command(op: 'prompt' | 'abort' | 'state', fields: Record<string, unknown> = {}): void {
    const tag = `c${this.steps.length}`
    this.step('socket', { op, tag, ...fields })
    const line = JSON.stringify({ op, tag, ...fields }) + '\n'
    if (this.peers.length === 0) this.notes.push(`socket ${op} ${tag}: no connected peer`)
    for (const peer of this.peers) peer.write(line)
  }

  events(): Array<Record<string, any>> {
    if (!existsSync(this.eventsFile)) return []
    return readFileSync(this.eventsFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  }

  count(name: string): number {
    return this.events().filter(e => e.name === name).length
  }

  async waitFor(label: string, predicate: () => boolean, timeoutMs = 15_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) {
        this.step('waited', { label })
        return true
      }
      await sleep(25)
    }
    this.step('timeout', { label })
    this.notes.push(`timeout waiting for: ${label}`)
    return false
  }

  // Ready = pi reported session_start and the screen stopped changing.
  async waitReady(sessionStarts: number): Promise<void> {
    await this.waitFor(`session_start #${sessionStarts}`, () => this.count('session_start') >= sessionStarts, 20_000)
    await this.quiet(600)
  }

  async quiet(ms: number): Promise<void> {
    let last = this.ptyChunks.length
    let stableSince = Date.now()
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      await sleep(50)
      if (this.ptyChunks.length !== last) {
        last = this.ptyChunks.length
        stableSince = Date.now()
      } else if (Date.now() - stableSince >= ms) return
    }
  }

  // A run is finished when pi has settled as many times as asked.
  async waitSettled(total: number, timeoutMs = 20_000): Promise<boolean> {
    const ok = await this.waitFor(`agent_settled #${total}`, () => this.count('agent_settled') >= total, timeoutMs)
    await this.quiet(300)
    return ok
  }

  latestFile(): string | undefined {
    const files = this.sessionFiles()
    return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
  }

  rows(file: string): Array<Record<string, any>> {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  }

  screen(): string[] {
    if (!this.term) return []
    const buffer = this.term.buffer.active
    const lines: string[] = []
    for (let y = 0; y < buffer.length; y += 1) lines.push(buffer.getLine(y)?.translateToString(true) ?? '')
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    return lines.slice(-ROWS * 3)
  }

  async exitPi(): Promise<void> {
    const before = this.exits.length
    this.key('ctrl-d', '\x04')
    if (!(await this.waitFor('exit after ctrl-d', () => this.exits.length > before, 4000))) {
      this.key('ctrl-c', '\x03')
      await sleep(200)
      this.key('ctrl-c', '\x03')
      if (!(await this.waitFor('exit after ctrl-c x2', () => this.exits.length > before, 4000))) {
        this.pty?.kill('SIGKILL')
        await this.waitFor('exit after SIGKILL', () => this.exits.length > before, 4000)
      }
    }
  }

  async close(): Promise<void> {
    if (this.growthTimer) clearInterval(this.growthTimer)
    for (const peer of this.peers) peer.destroy()
    await new Promise<void>(ok => this.server.close(() => ok()))
    rmSync(this.socketDir, { recursive: true, force: true })
  }

  toFixture(piVersion: string, sessionIdLaunched: string | undefined): Record<string, unknown> {
    const files: Record<string, unknown> = {}
    // WHY raw byte lengths per row: sanitizing the system prompt changes a
    // row's length, but the doorbell evidence (hypothesis H3) compares the
    // file size recorded INSIDE pi with row boundaries. Keeping each row's
    // original length lets tests rebuild exact offsets without the prose.
    const fileRowBytes: Record<string, number[]> = {}
    for (const file of this.sessionFiles()) {
      files[file] = this.rows(file).map(sanitizeRow)
      fileRowBytes[file] = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => Buffer.byteLength(line, 'utf8') + 1)
    }
    const fixture = {
      meta: {
        recordedWith: piVersion,
        scenario: this.scenario,
        recordedAt: new Date(this.t0).toISOString().slice(0, 10),
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        terminal: this.term ? '@xterm/headless' : 'hand-answered DA1',
        cols: COLS,
        rows: ROWS,
      },
      sessionIdLaunched: sessionIdLaunched ?? null,
      notes: this.notes,
      steps: this.steps,
      events: this.events(),
      growth: this.growth,
      exits: this.exits,
      pty: { chunks: this.ptyChunks.length, bytes: this.ptyChunks.reduce((n, c) => n + c.len, 0), da1HandAnswered: this.da1HandAnswered, screen: this.screen() },
      files,
      fileRowBytes,
    }
    // Normalize sandbox paths so fixtures are stable and carry no local paths.
    // Pi also encodes the cwd into the session directory NAME
    // (`--<cwd with / \\ : as ->--`), and quotes its own install path inside
    // system prompts, so both spellings are normalized too.
    const encodedRoot = this.root.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')
    const binaryReal = realpathSync(this.binary)
    const nodeModules = binaryReal.indexOf('/node_modules/')
    const installPrefix = nodeModules >= 0 ? binaryReal.slice(0, nodeModules) : dirname(binaryReal)
    let text = JSON.stringify(fixture)
    for (const [from, to] of [[this.root, '/sandbox'], [encodedRoot, 'sandbox'], [this.socketDir, '/sandbox-socket'], [HERE, '<scripts>'], [installPrefix, '<pi-install>']] as const) {
      text = text.split(from).join(to)
    }
    return JSON.parse(text)
  }
}

// Pi's own system prompt is recorded as section lengths only: it is large,
// it is Pi's text (not ours to pin), and the pipeline never reads it.
function sanitizeSystem(message: Record<string, any>): Record<string, any> {
  const out = { ...message }
  if (typeof out.content === 'string') out.content = `<text:${out.content.length}>`
  if (out.sections && typeof out.sections === 'object') {
    out.sections = Object.fromEntries(Object.entries(out.sections).map(([k, v]) => [k, typeof v === 'string' ? `<text:${v.length}>` : v]))
  }
  return out
}

function sanitizeRow(row: Record<string, any>): Record<string, any> {
  if (row?.type === 'message' && row.message?.role === 'system') return { ...row, message: sanitizeSystem(row.message) }
  // A compaction entry carries the system prompt it was summarized under.
  if (row?.type === 'compaction' && row.systemMessage && typeof row.systemMessage === 'object') {
    return { ...row, systemMessage: sanitizeSystem(row.systemMessage) }
  }
  return row
}

// ---------------------------------------------------------------------------
// Scenarios. Each drives the real TUI; expectations are NOT asserted here —
// the recordings are the evidence, analysed in research/ and replayed by tests.

type Scenario = (r: Recording) => Promise<string | undefined>

const fresh = () => randomUUID()

const turn = async (r: Recording, text: string, settles: number) => {
  r.type(text)
  r.key('enter', '\r')
  await r.waitSettled(settles)
}

const SCENARIOS: Record<string, Scenario> = {
  // One prompt, one text reply.
  async plain(r) {
    const id = fresh()
    r.spawn(['--session-id', id])
    await r.waitReady(1)
    await turn(r, 'hello [probe:plain]', 1)
    await r.exitPi()
    return id
  },
  // A two-step run: toolUse assistant → toolResult → final assistant.
  async tool(r) {
    const id = fresh()
    r.spawn(['--session-id', id])
    await r.waitReady(1)
    await turn(r, 'please [tool] now', 1)
    await turn(r, 'and again [tool]', 2)
    await r.exitPi()
    return id
  },
  // Esc mid-stream on the FIRST reply (the file does not exist yet) and on a
  // later reply (the file exists).
  async abort(r) {
    const id = fresh()
    r.spawn(['--session-id', id])
    await r.waitReady(1)
    r.type('long one [slow]')
    r.key('enter', '\r')
    await r.waitFor('streaming', () => r.count('message_update') > 5)
    r.key('esc', '\x1b')
    await r.waitSettled(1)
    await turn(r, 'short after abort', 2)
    r.type('long two [slow]')
    r.key('enter', '\r')
    const before = r.count('message_update')
    await r.waitFor('streaming again', () => r.count('message_update') > before + 5)
    r.key('esc', '\x1b')
    await r.waitSettled(3)
    await r.exitPi()
    return id
  },
  async error(r) {
    const id = fresh()
    r.spawn(['--session-id', id])
    await r.waitReady(1)
    await turn(r, 'fail please [error]', 1)
    await turn(r, 'recover after error', 2)
    await r.exitPi()
    return id
  },
  // Enter while busy queues a steer; Alt+Enter queues a follow-up.
  async queued(r) {
    const id = fresh()
    r.spawn(['--session-id', id])
    await r.waitReady(1)
    await turn(r, 'warm up', 1)
    r.type('long [slow] [probe:q1]')
    r.key('enter', '\r')
    await r.waitFor('streaming', () => r.count('message_update') > 5)
    r.type('steer me [probe:steer]')
    r.key('enter', '\r')
    await sleep(150)
    r.type('follow up [probe:follow]')
    r.key('alt-enter', '\x1b\r')
    await r.waitFor('all queued delivered', () => r.events().some(e => e.name === 'agent_settled' && e.pending === false && e.t > 0) && r.count('agent_settled') >= 2, 30_000)
    await r.quiet(800)
    await r.exitPi()
    return id
  },
  // Prompt delivery through the extension (the production path): idle,
  // busy + followUp, busy + steer, and busy without deliverAs (expected to be
  // refused by pi — recorded, not assumed).
  async socket(r) {
    const id = fresh()
    r.spawn(['--session-id', id])
    await r.waitReady(1)
    await r.waitFor('recorder connected', () => r.events().some(e => e.name === 'session_start'), 5000)
    await sleep(300)
    r.command('prompt', { text: 'socket idle [probe:s-idle]' })
    await r.waitSettled(1)
    r.type('long [slow]')
    r.key('enter', '\r')
    await r.waitFor('streaming', () => r.count('message_update') > 5)
    r.command('prompt', { text: 'socket busy no mode [probe:s-none]' })
    await sleep(100)
    r.command('prompt', { text: 'socket busy followUp [probe:s-follow]', deliverAs: 'followUp' })
    await sleep(100)
    r.command('prompt', { text: 'socket busy steer [probe:s-steer]', deliverAs: 'steer' })
    await r.waitFor('queue drained', () => r.count('agent_settled') >= 2 && r.events().at(-1)?.name === 'agent_settled', 30_000)
    await r.quiet(800)
    r.command('state')
    await sleep(300)
    await r.exitPi()
    return id
  },
  // The production bridge always passes deliverAs (a busy prompt without it
  // is dropped silently — recorded in the `socket` scenario). This records
  // that `followUp` is harmless while idle: Pi only reads it when streaming.
  async 'socket-idle-followup'(r) {
    const id = fresh()
    r.spawn(['--session-id', id])
    await r.waitReady(1)
    await sleep(300)
    r.command('prompt', { text: 'idle with followUp [probe:s-idle-follow]', deliverAs: 'followUp' })
    await r.waitSettled(1)
    r.command('state')
    await sleep(300)
    await r.exitPi()
    return id
  },
  // Abort through the extension while streaming.
  async 'socket-abort'(r) {
    const id = fresh()
    r.spawn(['--session-id', id])
    await r.waitReady(1)
    await turn(r, 'first', 1)
    r.type('long [slow]')
    r.key('enter', '\r')
    await r.waitFor('streaming', () => r.count('message_update') > 5)
    r.command('abort')
    await r.waitSettled(2)
    await r.exitPi()
    return id
  },
  // /new inside the TUI: a second file with a new id.
  async 'new-session'(r) {
    const id = fresh()
    r.spawn(['--session-id', id])
    await r.waitReady(1)
    await turn(r, 'in the first session', 1)
    r.type('/new')
    r.key('enter', '\r')
    await r.waitReady(2)
    await turn(r, 'in the second session', 2)
    await r.exitPi()
    return id
  },
  // /tree moves inside ONE file: branch without summary, then with summary.
  async tree(r) {
    const id = fresh()
    r.spawn(['--session-id', id])
    await r.waitReady(1)
    await turn(r, 'first [probe:t1]', 1)
    await turn(r, 'second [probe:t2]', 2)
    const file = r.latestFile()
    const rows = file ? r.rows(file) : []
    // Target: the assistant reply of the first turn → the next prompt
    // branches off after it, abandoning "second".
    const firstAssistant = rows.find(row => row.type === 'message' && row.message?.role === 'assistant')
    r.type(`/probe-tree ${firstAssistant?.id ?? 'missing'}`)
    r.key('enter', '\r')
    await r.waitFor('tree moved', () => r.count('session_tree') >= 1, 10_000)
    await r.quiet(300)
    await turn(r, 'branch b [probe:t3]', 3)
    const firstUser = rows.find(row => row.type === 'message' && row.message?.role === 'user')
    r.type(`/probe-tree ${firstUser?.id ?? 'missing'} summarize`)
    r.key('enter', '\r')
    await r.waitFor('tree moved with summary', () => r.count('session_tree') >= 2, 20_000)
    await r.quiet(500)
    await turn(r, 'branch c [probe:t4]', r.count('agent_settled') + 1)
    await r.exitPi()
    return id
  },
  // /fork: a new file whose header names the parent.
  async fork(r) {
    const id = fresh()
    r.spawn(['--session-id', id])
    await r.waitReady(1)
    await turn(r, 'first [probe:f1]', 1)
    await turn(r, 'second [probe:f2]', 2)
    const file = r.latestFile()
    const rows = file ? r.rows(file) : []
    const secondUser = rows.filter(row => row.type === 'message' && row.message?.role === 'user')[1]
    r.type(`/probe-fork ${secondUser?.id ?? 'missing'}`)
    r.key('enter', '\r')
    await r.waitReady(2)
    await turn(r, 'in the fork [probe:f3]', 3)
    await r.exitPi()
    return id
  },
  // Switching back to an older session file (what /resume does).
  async resume(r) {
    const id = fresh()
    r.spawn(['--session-id', id])
    await r.waitReady(1)
    await turn(r, 'session A [probe:rA]', 1)
    const fileA = r.latestFile()
    r.type('/new')
    r.key('enter', '\r')
    await r.waitReady(2)
    await turn(r, 'session B [probe:rB]', 2)
    r.type(`/probe-switch ${fileA ?? 'missing'}`)
    r.key('enter', '\r')
    await r.waitReady(3)
    await turn(r, 'back in A [probe:rA2]', 3)
    await r.exitPi()
    // A second process resumes A by id: the launch the app uses on restart.
    r.spawn(['--session-id', id])
    await r.waitReady(4)
    await turn(r, 'after relaunch [probe:rA3]', 4)
    await r.exitPi()
    return id
  },
  async compaction(r) {
    // WHY a tiny keepRecentTokens: the faux replies are a few tokens, so the
    // default (20k) makes Pi refuse with "Nothing to compact (session too
    // small)" — recorded on the first run. The user's own settings file is
    // the documented knob; this is the sandbox agent dir.
    writeFileSync(join(r.agentDir, 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 1 } }) + '\n')
    const id = fresh()
    r.spawn(['--session-id', id])
    await r.waitReady(1)
    await turn(r, 'one [probe:c1]', 1)
    await turn(r, 'two [probe:c2]', 2)
    await turn(r, 'three [probe:c3]', 3)
    r.type('/compact')
    r.key('enter', '\r')
    await r.waitFor('compacted', () => r.count('session_compact') + r.count('session_compact_failed') >= 1, 20_000)
    await r.quiet(500)
    await turn(r, 'after compaction [probe:c4]', r.count('agent_settled') + 1)
    await r.exitPi()
    return id
  },
  // A blocking extension dialog: ui_prompt_start/end and what the screen shows.
  async dialog(r) {
    const id = fresh()
    r.spawn(['--session-id', id])
    await r.waitReady(1)
    await turn(r, 'before dialog', 1)
    r.type('/probe-confirm')
    r.key('enter', '\r')
    await r.waitFor('dialog open', () => r.count('ui_prompt_start') >= 1, 5000)
    await r.quiet(400)
    r.step('screen', { lines: r.screen().slice(-12) })
    r.key('enter', '\r')
    await r.waitFor('dialog closed', () => r.count('ui_prompt_end') >= 1, 5000)
    await r.quiet(300)
    await r.exitPi()
    return id
  },
  // Project trust: the cwd carries project-local Pi resources.
  async trust(r) {
    mkdirSync(join(r.project, '.pi'), { recursive: true })
    writeFileSync(join(r.project, '.pi', 'settings.json'), '{}\n')
    const id = fresh()
    r.spawn(['--session-id', id])
    await r.waitFor('trust prompt or start', () => r.count('project_trust') >= 1 || r.count('session_start') >= 1, 10_000)
    await r.quiet(800)
    r.step('screen', { lines: r.screen().slice(-15) })
    // Decline (Esc) — the conservative answer; then observe whether pi starts.
    r.key('esc', '\x1b')
    await r.waitFor('session_start after trust', () => r.count('session_start') >= 1, 8000)
    await r.quiet(500)
    r.step('screen', { lines: r.screen().slice(-15) })
    await r.exitPi()
    return id
  },
  // The user's own `!cmd` bash execution.
  async 'user-bash'(r) {
    const id = fresh()
    r.spawn(['--session-id', id])
    await r.waitReady(1)
    await turn(r, 'first', 1)
    r.type('!echo from-user-bash')
    r.key('enter', '\r')
    await r.waitFor('user_bash', () => r.count('user_bash') >= 1, 5000)
    await r.quiet(800)
    await r.exitPi()
    return id
  },
  // A long pasted prompt (bracketed paste) — the host composer's delivery.
  async paste(r) {
    const id = fresh()
    r.spawn(['--session-id', id])
    await r.waitReady(1)
    r.paste(Array.from({ length: 30 }, (_, i) => `pasted line ${i} [probe:paste]`).join('\n'))
    await sleep(200)
    r.key('enter', '\r')
    await r.waitSettled(1)
    await r.exitPi()
    return id
  },
  // The process dies mid-stream (crash / app quit without cleanup).
  async kill(r) {
    const id = fresh()
    r.spawn(['--session-id', id])
    await r.waitReady(1)
    await turn(r, 'first', 1)
    r.type('long [slow]')
    r.key('enter', '\r')
    await r.waitFor('streaming', () => r.count('message_update') > 5)
    r.step('kill', { signal: 'SIGKILL' })
    r.pty?.kill('SIGKILL')
    await r.waitFor('exit', () => r.exits.length >= 1, 5000)
    await sleep(300)
    return id
  },
}

// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { binary: string; scenarios: string[]; out: string } {
  const out = { binary: '', scenarios: Object.keys(SCENARIOS), out: join(PACKAGE_ROOT, 'testing', 'fixtures', 'live') }
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1]
    if (argv[i] === '--binary' && value) { out.binary = resolve(value); i += 1 }
    else if (argv[i] === '--scenario' && value) { out.scenarios = value.split(','); i += 1 }
    else if (argv[i] === '--out' && value) { out.out = resolve(value); i += 1 }
  }
  if (!out.binary) throw new Error('--binary <path to pi> is required')
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const piVersion = execFileSync(args.binary, ['--version'], { encoding: 'utf8', env: { ...process.env, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' } }).trim()
  mkdirSync(args.out, { recursive: true })
  for (const name of args.scenarios) {
    const scenario = SCENARIOS[name]
    if (!scenario) throw new Error(`unknown scenario ${name}`)
    const r = new Recording(name, args.binary)
    await r.listen()
    r.startGrowthPoll()
    let id: string | undefined
    try {
      id = await scenario(r)
    } catch (error) {
      r.notes.push(`scenario threw: ${String((error as Error)?.stack ?? error)}`)
      r.pty?.kill('SIGKILL')
    }
    await sleep(200)
    await r.close()
    const fixture = r.toFixture(piVersion, id)
    writeFileSync(join(args.out, `${name}.json`), JSON.stringify(fixture, null, 1) + '\n')
    console.log(`${name}: ${(fixture.events as unknown[]).length} events, ${Object.keys(fixture.files as object).length} file(s), notes: ${(fixture.notes as string[]).length}`)
    if (!process.env.PI_PROBE_KEEP) rmSync(r.root, { recursive: true, force: true })
  }
}

await main()
