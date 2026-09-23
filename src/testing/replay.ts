// Replay rig: re-enacts a Stage 0 recording against the REAL package — a real
// Unix socket, real files on disk, the real root class — with only Pi and its
// PTY faked.
//
// The ordering is the recording's own: before each bridge event is sent, the
// session file is written up to exactly the byte count pi had on disk when
// that event's handler ran (the recorder captured `fileBytes` inside pi), and
// no further. That is what makes "the answer before the turn end" and "the
// doorbell finds its row" testable without timing guesses.
//
// Also exported for Agent Code's tests (opencode-terminal-headless precedent),
// through the `pi-terminal-headless/testing/index` alias.

import { EventEmitter } from 'node:events'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { BRIDGE_PROTOCOL_VERSION } from '../bridge/protocol.js'
import type { PiTerminalLaunch } from '../launch/prepareLaunch.js'
import type { PtyExitEvent, PtyLike } from '../terminal/PtyBinding.js'
import { bridgeEventsFromRecording } from './bridgeEvents.js'
import type { LiveFixture } from './fixtures.js'

/** A PTY double: records writes, exits on demand. */
export class FakePty implements PtyLike {
  readonly pid = 4242
  readonly writes: string[] = []
  private readonly emitter = new EventEmitter()
  private exitedWith: PtyExitEvent | undefined
  write(data: string): void {
    this.writes.push(data)
  }
  resize(): void {}
  onExit(listener: (event: PtyExitEvent) => void) {
    this.emitter.on('exit', listener)
    return { dispose: () => this.emitter.off('exit', listener) }
  }
  // Same signature as opencode-terminal-headless's FakePty (1:1 packages).
  // Unlike a real PTY it can report twice on purpose: the binding must
  // tolerate a buggy wrapper that does.
  exit(exitCode = 0, signal?: number): void {
    this.exitedWith = { exitCode, signal }
    this.emitter.emit('exit', this.exitedWith)
  }
  listenerCount(): number {
    return this.emitter.listenerCount('exit')
  }
}

export type ReplaySandbox = {
  root: string
  sessionDir: string
  launch: PiTerminalLaunch
  /** Recording path (/sandbox/...) → real path in this sandbox. */
  mapPath(path: string): string
  cleanup(): void
}

/**
 * A sandbox shaped like pi's session directory for this recording, plus a
 * launch whose socket/token a fake bridge can use.
 */
export function createReplaySandbox(fixture: LiveFixture, options: { resumeExisting?: string } = {}): ReplaySandbox {
  const root = mkdtempSync(join(tmpdir(), 'pi-replay-'))
  // Socket in its own short directory (104-byte sun_path limit).
  const socketDir = mkdtempSync('/tmp/acpi-r-')
  const mapPath = (path: string) => (path.startsWith('/sandbox/') ? join(root, path.slice('/sandbox/'.length)) : path)
  const anyFile = Object.keys(fixture.files)[0] ?? '/sandbox/agent/sessions/--sandbox-project--/none.jsonl'
  const sessionDir = dirname(mapPath(anyFile))
  mkdirSync(sessionDir, { recursive: true })
  const existingFile = options.resumeExisting ? mapPath(options.resumeExisting) : null
  const launch: PiTerminalLaunch = {
    binary: 'pi',
    args: [],
    env: {},
    sessionId: fixture.sessionIdLaunched ?? 'unknown',
    cwd: join(root, 'project'),
    sessionDir,
    existingFile,
    socketPath: join(socketDir, 's'),
    token: `replay-${Math.random().toString(36).slice(2)}`,
    dispose: async () => undefined,
  }
  return {
    root,
    sessionDir,
    launch,
    mapPath,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true })
      rmSync(socketDir, { recursive: true, force: true })
    },
  }
}

/** Writes each recorded file progressively, row by row, up to a byte count. */
class FileWriter {
  private written = new Map<string, number>() // rows written per file

  constructor(private readonly fixture: LiveFixture, private readonly mapPath: (p: string) => string) {}

  /** Ensure `file` holds every row whose end offset is ≤ `bytes` (pi's view at that instant). */
  upTo(file: string, bytes: number): void {
    const rows = this.fixture.files[file]
    const lengths = this.fixture.fileRowBytes[file]
    if (!rows || !lengths || bytes < 0) return
    let end = 0
    let count = 0
    for (const length of lengths) {
      if (end + length > bytes) break
      end += length
      count += 1
    }
    const already = this.written.get(file) ?? 0
    if (count <= already) return
    const real = this.mapPath(file)
    mkdirSync(dirname(real), { recursive: true })
    const text = rows.slice(already, count).map(row => JSON.stringify(row) + '\n').join('')
    if (already === 0) writeFileSync(real, text)
    else appendFileSync(real, text)
    this.written.set(file, count)
  }

  /** Everything (end of recording). */
  all(): void {
    for (const file of Object.keys(this.fixture.files)) this.upTo(file, Number.MAX_SAFE_INTEGER)
  }
}

export type ReplayOptions = {
  /** Pause between events so the package's async reads interleave realistically. */
  stepMs?: number
  /** Stop before sending events at or after this recorded time (ms). */
  untilT?: number
  /** Skip the bridge entirely (degradation tests): only the file is written. */
  noBridge?: boolean
}

/**
 * Connect as the bridge extension and replay the recording. Resolves when the
 * last event has been sent and every file is complete.
 */
export async function playReplay(fixture: LiveFixture, sandbox: ReplaySandbox, options: ReplayOptions = {}): Promise<void> {
  const writer = new FileWriter(fixture, sandbox.mapPath)
  const stepMs = options.stepMs ?? 2
  let socket: Socket | undefined
  if (!options.noBridge) {
    socket = connect(sandbox.launch.socketPath)
    socket.on('error', () => undefined)
    await new Promise<void>((resolve, reject) => {
      socket!.once('connect', () => resolve())
      socket!.once('error', reject)
    })
    socket.write(JSON.stringify({ t: 'hello', token: sandbox.launch.token, protocol: BRIDGE_PROTOCOL_VERSION, pid: 1, piVersion: fixture.meta.recordedWith }) + '\n')
    // Answer state requests like the extension would (no prompt handling:
    // prompt delivery is covered by the extension's own tests).
    let buffer = ''
    socket.on('data', data => {
      buffer += data.toString('utf8')
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        if (frame.t === 'request') socket!.write(JSON.stringify({ t: 'reply', id: frame.id, ok: false, error: 'replay rig does not serve requests' }) + '\n')
      }
    })
  }
  const recorded = fixture.events
  const bridgeEvents = bridgeEventsFromRecording(fixture)
  let bridgeIndex = 0
  for (const event of recorded) {
    if (options.untilT !== undefined && event.t >= options.untilT) break
    // Bring the file to exactly what pi had on disk when this handler ran.
    if (event.sessionFile && typeof event.fileBytes === 'number') writer.upTo(event.sessionFile, event.fileBytes)
    // Send every bridge event translated from recorded events up to this one.
    while (bridgeIndex < bridgeEvents.length && bridgeEvents[bridgeIndex]!.t <= event.t) {
      const { t, event: bridgeEvent } = bridgeEvents[bridgeIndex]!
      bridgeIndex += 1
      if (!socket) continue
      const mapped = JSON.parse(JSON.stringify(bridgeEvent), (_key, value) => (typeof value === 'string' ? sandbox.mapPath(value) : value))
      socket.write(JSON.stringify({ t: 'event', at: t, event: mapped }) + '\n')
    }
    if (stepMs > 0) await new Promise(resolve => setTimeout(resolve, stepMs))
  }
  if (options.untilT === undefined) writer.all()
  // Let the last frames drain before the caller asserts or exits the PTY.
  await new Promise(resolve => setTimeout(resolve, 20))
  if (options.untilT === undefined) socket?.end()
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 5_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
