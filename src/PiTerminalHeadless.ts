// PiTerminalHeadless — the package's root class.
//
// The caller spawns `pi` in a PTY (arguments and env from
// preparePiTerminalLaunch) and passes the PTY in. This class never spawns or
// kills a process; it observes the TUI through two channels and reports it in
// the provider event shape Agent Code consumes:
//
//   durable — DurableReader tails the session JSONL (what was said);
//   live    — BridgeServer + LiveStateProjector, fed by the bridge extension
//             inside pi (when, and which session/branch is live).
//
// SessionSequencer is the only place the two meet (reconcile/). Conditions are
// attention-only (conditions/modules.ts). There is no screen mirror.
//
// Degradation (spec §3 D10): if the bridge never connects (an old pi, a
// failed extension load, a socket problem), the pane is still a working TUI,
// the transcript still arrives from the file (found by directory scan), status
// is reported as unknown — never a fabricated idle — prompt delivery refuses
// with `no-live-channel`, and `live-state` says why.

import { EventEmitter } from 'node:events'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { BridgeRequestError, BridgeServer } from './live/BridgeServer.js'
import { LiveStateProjector } from './live/LiveStateProjector.js'
import type { PendingDialog } from './live/types.js'
import type { PromptOutcome } from './bridge/protocol.js'
import { CommittedChannel, ScreenChannel, SemanticChannel } from './channels/channels.js'
import type { SemanticEvent } from './channels/types.js'
import { makeEvaluator } from './conditions/core/evaluator.js'
import type { ConditionSnapshot } from './conditions/core/contract.js'
import { PI_TERMINAL_MODULES, type PiConditionInputs } from './conditions/modules.js'
import type { PiTerminalLaunch } from './launch/prepareLaunch.js'
import { sessionIdFromFileName } from './launch/sessionPaths.js'
import { SessionSequencer } from './reconcile/SessionSequencer.js'
import { PtyBinding, type PtyLike } from './terminal/PtyBinding.js'
import { DurableReader } from './transcript/DurableReader.js'
import type { PiSessionRow } from './transcript/SessionFile.js'

export type PiActivity = { active: boolean | null; status: string }

export type PiTerminalError = { channel: 'durable' | 'live'; code: string; message: string }

export type SubmitPromptResult =
  | { ok: true; outcome: Exclude<PromptOutcome, 'unknown'> }
  /**
   * not-sent / no-live-channel / rejected: pi never took the text — safe to
   * retry or to report as undelivered. unknown: the request reached pi but
   * no evidence came back; the text MAY still appear, so callers must not
   * resubmit it automatically (the #877 lesson, from the other direction).
   */
  | { ok: false; reason: 'no-live-channel' | 'rejected' | 'unknown'; message?: string }
  /**
   * The text is one of pi's own TUI commands (`/new`, `/tree`, `/model x`,
   * ...), which cannot be run from outside the TUI. Nothing reached pi, and
   * retrying never helps: the user has to type it in the pane.
   */
  | { ok: false; reason: 'tui-command'; message: string }

export type PiTerminalHeadlessEvents = {
  activity: [PiActivity]
  entry: [{ row: PiSessionRow; file: string }]
  history: [{ kind: 'reset' | 'caught-up'; file: string }]
  semantic: [SemanticEvent]
  conditions: [ConditionSnapshot<'pi'>]
  'transcript-error': [PiTerminalError]
  'live-state': [{ connected: boolean; reason?: string; piVersion?: string }]
  'session-switched': [{ from: { sessionId: string; file: string | null }; to: { sessionId: string; file: string }; reason: string }]
  exit: [{ exitCode: number; signal?: number }]
}

export type PiTerminalHeadlessOptions = {
  pty: PtyLike
  launch: PiTerminalLaunch
  now?: () => number
  /** Re-emit busy activity at this interval (Agent Code has no process-state cache). */
  heartbeatMs?: number
  /** After this long without an authenticated bridge, report live-state disconnected. */
  bridgeConnectDeadlineMs?: number
  settleDeadlineMs?: number
  fastPollMs?: number
  slowPollMs?: number
  /** Directory scan interval while the launched session's file is unknown. */
  discoverPollMs?: number
}

// WHY 30 s: the bridge connects at pi's session_start, which follows Pi's
// startup (package loading, a possible trust prompt the user has to answer).
// Until then "no bridge yet" is normal; after it, it is a diagnostic. Same
// order as OpenCode Terminal's live-connect deadline.
const DEFAULT_BRIDGE_CONNECT_DEADLINE_MS = 30_000

export class PiTerminalHeadless extends EventEmitter<PiTerminalHeadlessEvents> {
  readonly semanticChannel = new SemanticChannel()
  readonly screenChannel = new ScreenChannel()
  readonly committedChannel = new CommittedChannel()

  private readonly binding: PtyBinding
  private readonly launch: PiTerminalLaunch
  private readonly server: BridgeServer
  private readonly projector = new LiveStateProjector()
  private readonly sequencer: SessionSequencer
  private readonly evaluator = makeEvaluator<'pi', PiConditionInputs>('pi', PI_TERMINAL_MODULES, Date.now)
  private reader: DurableReader | undefined
  private conditionInputs: PiConditionInputs = { dialog: null, trustPending: false }
  private conditionSnapshot: ConditionSnapshot<'pi'> = { provider: 'pi', conditions: {}, ts: Date.now() }
  private activity: PiActivity = { active: null, status: 'unknown' }
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private connectDeadline: ReturnType<typeof setTimeout> | null = null
  private discoverTimer: ReturnType<typeof setInterval> | null = null
  private started = false
  private stopped = false
  private exited = false
  private readonly now: () => number

  constructor(private readonly options: PiTerminalHeadlessOptions) {
    super()
    this.launch = options.launch
    this.now = options.now ?? Date.now
    // Latch exit from construction on (PtyBinding): a pi that dies before
    // start() must still be observed.
    this.binding = new PtyBinding(options.pty)
    this.server = new BridgeServer(options.launch.socketPath, options.launch.token)
    this.sequencer = new SessionSequencer(
      {
        entry: (row, file) => {
          this.emit('entry', { row, file })
          this.committedChannel.publish({ type: 'entry', row, file, ts: this.now() })
        },
        history: (kind, file) => {
          this.emit('history', { kind, file })
          this.committedChannel.publish({ type: 'history', kind, file, ts: this.now() })
        },
        semantic: event => {
          this.emit('semantic', event)
          this.semanticChannel.publish(event)
        },
        activity: activity => this.setActivity(activity),
        dialogs: (dialog, trustPending) => this.setDialogs(dialog, trustPending),
        sessionSwitched: (from, to, reason) => this.emit('session-switched', { from, to, reason }),
        retarget: file => this.follow(file),
        ring: () => this.reader?.ring() ?? Promise.resolve(),
        error: (code, message) => this.reportError('live', code, message),
      },
      { sessionId: options.launch.sessionId, file: options.launch.existingFile, attachExisting: options.launch.existingFile !== null },
      {
        ...(options.now ? { now: options.now } : {}),
        ...(options.settleDeadlineMs !== undefined ? { settleDeadlineMs: options.settleDeadlineMs } : {}),
      },
    )
  }

  async start(): Promise<void> {
    if (this.started || this.stopped) return
    this.started = true
    this.binding.onExit(event => this.handleExit(event))
    if (this.exited) return
    if (this.launch.existingFile) this.follow(this.launch.existingFile)
    else this.startDiscovery()
    this.server.on('event', event => {
      if (this.exited) return
      this.sequencer.onLive(this.projector.apply(event))
    })
    this.server.on('connected', ({ piVersion }) => {
      if (this.connectDeadline) clearTimeout(this.connectDeadline)
      this.connectDeadline = null
      this.reader?.setLiveConnected(true)
      this.emit('live-state', { connected: true, ...(piVersion ? { piVersion } : {}) })
    })
    this.server.on('disconnected', ({ reason }) => {
      if (reason === 'replaced' || this.exited) return
      this.reader?.setLiveConnected(false)
      this.sequencer.onLive(this.projector.bridgeLost())
      this.emit('live-state', { connected: false, reason: 'bridge-disconnected' })
    })
    this.server.on('refused', ({ reason }) => this.reportError('live', 'bridge_refused', reason))
    try {
      await this.server.listen()
    } catch (error) {
      if (this.stopped) return // stopped while starting: nothing to report
      // Degrade, never throw into the host's spawn path: the TUI works
      // without us, and the durable channel does not need the socket.
      this.reportError('live', 'bridge_listen_failed', (error as Error).message)
      this.emit('live-state', { connected: false, reason: 'bridge-listen-failed' })
      return
    }
    if (this.stopped) return
    this.connectDeadline = setTimeout(() => {
      this.connectDeadline = null
      if (!this.server.isConnected() && !this.exited) this.emit('live-state', { connected: false, reason: 'bridge-unreachable' })
    }, this.options.bridgeConnectDeadlineMs ?? DEFAULT_BRIDGE_CONNECT_DEADLINE_MS)
    this.connectDeadline.unref?.()
    this.publishConditions(true)
  }

  /** Detach without killing pi (the caller owns it). Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    await this.teardown()
  }

  write(data: string): void {
    this.binding.write(data)
  }

  resize(cols: number, rows: number): void {
    this.binding.resize(cols, rows)
  }

  /** Host composer only — programmatic delivery must use submitPrompt. */
  pasteAndSubmit(text: string): void {
    this.binding.pasteAndSubmit(text)
  }

  /** Deliver a prompt through the bridge, with Pi's own evidence of acceptance. */
  async submitPrompt(text: string, options: { timeoutMs?: number } = {}): Promise<SubmitPromptResult> {
    if (this.exited || this.stopped) return { ok: false, reason: 'no-live-channel', message: 'pi is not running' }
    try {
      const { outcome } = await this.server.prompt(text, options.timeoutMs ?? 10_000)
      return outcome === 'unknown' ? { ok: false, reason: 'unknown' } : { ok: true, outcome }
    } catch (error) {
      if (error instanceof BridgeRequestError) {
        if (error.code === 'no-live-channel') return { ok: false, reason: 'no-live-channel', message: error.message }
        if (error.code === 'rejected') return error.refusal === 'tui-command' ? { ok: false, reason: 'tui-command', message: error.message } : { ok: false, reason: 'rejected', message: error.message }
        // timeout / closed after sending: the text may or may not arrive.
        return { ok: false, reason: 'unknown', message: error.message }
      }
      return { ok: false, reason: 'unknown', message: (error as Error)?.message }
    }
  }

  /** Esc, from outside: abort the running reply. */
  async abort(): Promise<boolean> {
    try {
      await this.server.abort()
      return true
    } catch {
      return false
    }
  }

  getProviderSessionId(): string {
    return this.sequencer.currentSessionId()
  }

  /** The session file being followed; null until a fresh session's file is known. */
  getTranscriptFile(): string | null {
    return this.sequencer.currentFile()
  }

  getActivity(): PiActivity {
    return this.activity
  }

  getConditionSnapshot(): ConditionSnapshot<'pi'> {
    return this.conditionSnapshot
  }

  isExited(): boolean {
    return this.exited
  }

  isLiveConnected(): boolean {
    return this.server.isConnected()
  }

  // ---------------------------------------------------------------------------

  private follow(file: string): void {
    this.stopDiscovery()
    if (this.reader) {
      this.reader.retarget(file)
      return
    }
    this.reader = new DurableReader(
      file,
      {
        onRows: rows => this.sequencer.onDurableRows(rows, this.reader?.getFile() ?? file),
        onReset: () => this.sequencer.onDurableReset(this.reader?.getFile() ?? file),
        onError: error => this.reportError('durable', (error as { code?: string }).code ?? 'read_failed', error.message),
      },
      {
        ...(this.options.fastPollMs !== undefined ? { fastPollMs: this.options.fastPollMs } : {}),
        ...(this.options.slowPollMs !== undefined ? { slowPollMs: this.options.slowPollMs } : {}),
      },
    )
    this.reader.setLiveConnected(this.server.isConnected())
    this.reader.start()
  }

  /**
   * A fresh session's file name carries a timestamp we cannot predict, and
   * the file does not exist until the first reply completes (H1). The bridge
   * normally names it at session_start; this scan is the fallback that keeps
   * the transcript working when no bridge ever connects.
   */
  private startDiscovery(): void {
    const scan = async () => {
      try {
        const names = await readdir(this.launch.sessionDir)
        const match = names.filter(name => sessionIdFromFileName(name) === this.launch.sessionId).sort().at(-1)
        if (match && !this.sequencer.currentFile()) this.sequencer.discoveredFile(join(this.launch.sessionDir, match))
      } catch {
        // The directory itself appears with the first write.
      }
    }
    this.discoverTimer = setInterval(() => void scan(), this.options.discoverPollMs ?? 250)
    this.discoverTimer.unref?.()
  }

  private stopDiscovery(): void {
    if (this.discoverTimer) clearInterval(this.discoverTimer)
    this.discoverTimer = null
  }

  private setActivity(activity: PiActivity): void {
    this.activity = activity
    this.emit('activity', activity)
    this.screenChannel.publish({ type: 'activity', active: activity.active === true, status: activity.status, ts: this.now() })
    if (activity.active === true) this.startHeartbeat()
    else this.stopHeartbeat()
  }

  // WHY a heartbeat: Agent Code keeps no process-state cache for a pane; a
  // window that attaches mid-turn learns "busy" only from the next activity
  // event. 1 s matches opencode-terminal-headless.
  private startHeartbeat(): void {
    const interval = this.options.heartbeatMs ?? 1_000
    if (this.heartbeat || interval <= 0) return
    this.heartbeat = setInterval(() => {
      if (this.activity.active === true && !this.exited) this.emit('activity', this.activity)
    }, interval)
    this.heartbeat.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  private setDialogs(dialog: PendingDialog | null, trustPending: boolean): void {
    this.conditionInputs = { dialog, trustPending }
    this.screenChannel.publish({ type: 'dialog', state: dialog, trustPending, ts: this.now() })
    this.publishConditions(false)
  }

  private publishConditions(force: boolean): void {
    const snapshot = this.evaluator.evaluate(this.conditionInputs)
    const changed = this.evaluator.changed(this.evaluator.keyOf(snapshot))
    if (!changed && !force) return
    this.conditionSnapshot = snapshot
    this.emit('conditions', snapshot)
  }

  private reportError(channel: 'durable' | 'live', code: string, message: string): void {
    const error: PiTerminalError = { channel, code, message }
    this.emit('transcript-error', error)
    if (channel === 'durable') this.committedChannel.publish({ type: 'tail_error', code, message, ts: this.now() })
  }

  private handleExit(event: { exitCode: number; signal?: number }): void {
    if (this.exited) return
    this.exited = true
    this.sequencer.onExit(this.projector.endForExit(), () => {
      if (this.activity.active !== false) this.setActivity({ active: false, status: 'exited' })
      void this.teardown().finally(() => this.emit('exit', event))
    })
  }

  private async teardown(): Promise<void> {
    this.stopHeartbeat()
    this.stopDiscovery()
    if (this.connectDeadline) clearTimeout(this.connectDeadline)
    this.connectDeadline = null
    this.binding.detach()
    this.sequencer.dispose()
    await Promise.allSettled([this.reader?.stop(), this.server.close(), this.launch.dispose()])
  }
}
