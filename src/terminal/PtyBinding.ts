// The thin PTY binding. The caller owns the process (spawn and kill), exactly
// like claude-code-headless and codex-headless; the package only observes exit
// and writes input.
//
// Copied from opencode-terminal-headless (same contract, same exit-latching
// fix), per the rule that provider packages mirror each other 1:1.
//
// WHY there is no headless xterm here: the siblings mirror the screen because
// Claude's and Codex's state lives on it. Pi's does not (the bridge carries
// it), and the 60 Hz snapshot churn is the most expensive thing the older
// packages do. Agent Code keeps its own raw-byte replay buffer for the visible
// terminal, and the pane's xterm.js answers Pi's startup DA1 / keyboard
// queries (research H8), so nothing here needs the bytes at all.

export type PtyDisposable = { dispose(): void }

export type PtyExitEvent = { exitCode: number; signal?: number }

/** Structural subset of node-pty's IPty that the package uses. */
export type PtyLike = {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  onExit(listener: (event: PtyExitEvent) => void): PtyDisposable
}

export class PtyBinding {
  private subscription: PtyDisposable | null = null
  private exitEvent: PtyExitEvent | null = null
  private listener: ((event: PtyExitEvent) => void) | null = null
  private delivered = false
  private detached = false

  /**
   * Subscribes to the PTY's exit AT ONCE, not when the owner starts.
   *
   * WHY at construction: the PTY contract offers an exit subscription, not an
   * "already exited" query or a replay. A CLI that dies between the owner's
   * construction and its `start()` (bad arguments, a missing session) would
   * otherwise exit unobserved, and the owner would wait for a server that is
   * never coming. The exit is latched here and handed to the owner's listener
   * when it subscribes (`onExit`).
   */
  constructor(private readonly pty: PtyLike) {
    const subscription = pty.onExit(event => this.handlePtyExit(event))
    // A PTY may deliver an already-latched exit synchronously from inside
    // `onExit()`, before `subscription` is assigned. The handler has then
    // latched it, and the subscription is released here instead.
    if (this.exitEvent) subscription.dispose()
    else this.subscription = subscription
  }

  /**
   * Route the exit to `listener`. An exit that already happened is delivered
   * synchronously, inside this call; either way it is delivered exactly once,
   * and never after `detach()`.
   */
  onExit(listener: (event: PtyExitEvent) => void): void {
    if (this.detached || this.listener) return
    this.listener = listener
    this.deliver()
  }

  /** Stop observing without killing the process (the caller owns it). Idempotent. */
  detach(): void {
    this.detached = true
    this.listener = null
    this.subscription?.dispose()
    this.subscription = null
  }

  isExited(): boolean {
    return this.exitEvent !== null
  }

  /** Is the binding still subscribed to the PTY? Test seam for the retention fix. */
  isSubscribed(): boolean {
    return this.subscription !== null
  }

  get pid(): number {
    return this.pty.pid
  }

  write(data: string): void {
    if (this.exitEvent) return
    this.pty.write(data)
  }

  resize(cols: number, rows: number): void {
    try {
      this.pty.resize(cols, rows)
    } catch {
      // Layout transitions can report 0x0 for a frame; the next measurement
      // corrects it. Losing one resize is better than killing the agent.
    }
  }

  /**
   * Paste text into Pi's editor and submit it, as one write.
   *
   * WHY one write with bracketed paste: Pi's editor enables bracketed paste
   * and keeps a pasted multi-line block as one prompt (Stage 0 `paste`
   * recording: 30 lines + Enter = one user message), and a single write cannot
   * interleave with other input between the text and its Enter. Only for the
   * host's own composer interactions; programmatic delivery uses
   * PiTerminalHeadless.submitPrompt (the bridge), because a paste into a TUI
   * that is not ready is silently lost and nobody can tell (the #877 lesson).
   */
  pasteAndSubmit(text: string): void {
    this.write(`\x1b[200~${text}\x1b[201~\r`)
  }

  private handlePtyExit(event: PtyExitEvent): void {
    // A PTY reports exit once; a second report (a buggy wrapper, or a test
    // double) must not end the owner twice.
    if (this.exitEvent) return
    this.exitEvent = event
    // WHY release the PTY subscription as soon as the exit is latched: an
    // exited process has nothing more to report, and a host that retains
    // exited PTYs (for diagnostics or replay) would otherwise keep this
    // closure — and through it the owner's channels, projector and launch
    // environment — alive for as long as it keeps the PTY. Doing it here
    // rather than in the owner's teardown makes the release hold on every exit
    // path, natural exit included. Disposing from inside the PTY's own exit
    // callback is safe: node-pty's emitter (and FakePty) iterate a copy of
    // their listeners.
    this.subscription?.dispose()
    this.subscription = null
    this.deliver()
  }

  private deliver(): void {
    if (!this.exitEvent || !this.listener || this.delivered) return
    this.delivered = true
    this.listener(this.exitEvent)
  }
}
