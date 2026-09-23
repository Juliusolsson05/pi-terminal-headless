// Host side of the bridge: listens on the per-spawn Unix socket, admits the
// one extension that knows the token, turns frames into events, and carries
// request/reply correlation for prompt / abort / state.
//
// WHY the host listens and the extension connects: listening is the risky
// half (address in use, path too long, permissions), and a listen error
// inside Pi kills the user's session (Stage 0). Here, a listen failure is an
// ordinary rejected promise in Agent Code's main process.
//
// WHY "latest authenticated peer wins": Pi re-runs extension factories on
// /reload and on every session switch. The bridge keeps one link per process
// (extension.ts singleton), but if the extension module is re-evaluated in a
// fresh jiti context a second connection with the same token can arrive; the
// newer one is the live runtime. Anything without the token is dropped.

import { EventEmitter } from 'node:events'
import { rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'

import { BRIDGE_PROTOCOL_VERSION, type BridgeEvent, type BridgeRequest, type BridgeState, type PromptOutcome } from '../bridge/protocol.js'

export type BridgeServerEvents = {
  event: [BridgeEvent, number]
  connected: [{ pid: number; piVersion?: string }]
  disconnected: [{ reason: 'closed' | 'replaced' }]
  /** A peer was refused (bad token / protocol) — reported, never thrown. */
  refused: [{ reason: string }]
}

export class BridgeRequestError extends Error {
  constructor(readonly code: 'no-live-channel' | 'timeout' | 'rejected' | 'closed', message: string) {
    super(message)
    this.name = 'BridgeRequestError'
  }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

// A hello must arrive promptly; a connection that says nothing is not ours.
const HELLO_DEADLINE_MS = 5_000

export class BridgeServer extends EventEmitter<BridgeServerEvents> {
  private server: Server | undefined
  private peer: Socket | undefined
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private closed = false

  constructor(private readonly socketPath: string, private readonly token: string) {
    super()
  }

  async listen(): Promise<void> {
    if (this.closed) throw new BridgeRequestError('closed', 'bridge server closed before listening')
    const server = createServer(socket => this.admit(socket))
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      // WHY also settle on 'close': a close() racing this listen (the host
      // stopping a pane while it is still starting) would otherwise leave the
      // listen callback — and the host's start() — pending forever.
      server.once('close', () => reject(new BridgeRequestError('closed', 'bridge server closed while listening')))
      server.listen(this.socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })
    if (this.closed) throw new BridgeRequestError('closed', 'bridge server closed while listening')
    // After listening, a server error must not become an uncaught exception
    // in Agent Code's main process; the peer-level events tell the story.
    server.on('error', () => undefined)
  }

  isConnected(): boolean {
    return this.peer !== undefined
  }

  /** Ask pi to take a prompt. Resolves with Pi's own evidence (see extension.ts). */
  prompt(text: string, timeoutMs = 10_000): Promise<{ outcome: PromptOutcome }> {
    return this.request({ op: 'prompt', text }, timeoutMs) as Promise<{ outcome: PromptOutcome }>
  }

  abort(timeoutMs = 5_000): Promise<{ aborted: true }> {
    return this.request({ op: 'abort' }, timeoutMs) as Promise<{ aborted: true }>
  }

  state(timeoutMs = 5_000): Promise<BridgeState> {
    return this.request({ op: 'state' }, timeoutMs) as Promise<BridgeState>
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.failPending(new BridgeRequestError('closed', 'bridge server closed'))
    this.peer?.destroy()
    this.peer = undefined
    // close() on a server that never finished listening still calls back
    // (with ERR_SERVER_NOT_RUNNING), so this cannot hang.
    await new Promise<void>(resolve => (this.server ? this.server.close(() => resolve()) : resolve()))
    // The socket file outlives the server on POSIX; the launch helper removes
    // the whole private directory, this is belt and braces for direct users.
    await rm(this.socketPath, { force: true }).catch(() => undefined)
  }

  private request(request: BridgeRequest, timeoutMs: number): Promise<unknown> {
    const peer = this.peer
    if (!peer || this.closed) return Promise.reject(new BridgeRequestError('no-live-channel', 'the Pi bridge is not connected'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BridgeRequestError('timeout', `no reply from the Pi bridge within ${timeoutMs} ms`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      peer.write(JSON.stringify({ t: 'request', id, ...request }) + '\n')
    })
  }

  private admit(socket: Socket): void {
    socket.on('error', () => undefined)
    let authenticated = false
    let buffer = ''
    const helloTimer = setTimeout(() => {
      if (!authenticated) this.refuse(socket, 'no hello')
    }, HELLO_DEADLINE_MS)
    helloTimer.unref?.()
    socket.on('data', data => {
      buffer += data.toString('utf8')
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        let frame: any
        try {
          frame = JSON.parse(line)
        } catch {
          if (!authenticated) return this.refuse(socket, 'malformed hello')
          continue
        }
        if (!authenticated) {
          clearTimeout(helloTimer)
          if (frame?.t !== 'hello' || frame.token !== this.token) return this.refuse(socket, 'bad token')
          if (frame.protocol !== BRIDGE_PROTOCOL_VERSION) return this.refuse(socket, `protocol ${String(frame.protocol)}`)
          authenticated = true
          const previous = this.peer
          this.peer = socket
          if (previous && previous !== socket) {
            // Requests sent to the replaced runtime will never be answered.
            this.failPending(new BridgeRequestError('closed', 'the Pi runtime was replaced'))
            previous.destroy()
            this.emit('disconnected', { reason: 'replaced' })
          }
          this.emit('connected', { pid: Number(frame.pid), ...(typeof frame.piVersion === 'string' ? { piVersion: frame.piVersion } : {}) })
          continue
        }
        this.receive(frame)
      }
    })
    socket.on('close', () => {
      clearTimeout(helloTimer)
      if (this.peer !== socket) return
      this.peer = undefined
      this.failPending(new BridgeRequestError('closed', 'the Pi bridge disconnected'))
      if (!this.closed) this.emit('disconnected', { reason: 'closed' })
    })
  }

  private receive(frame: any): void {
    if (frame?.t === 'event' && frame.event && typeof frame.event.name === 'string') {
      this.emit('event', frame.event as BridgeEvent, Number(frame.at) || Date.now())
      return
    }
    if (frame?.t === 'reply' && typeof frame.id === 'number') {
      const pending = this.pending.get(frame.id)
      if (!pending) return
      this.pending.delete(frame.id)
      clearTimeout(pending.timer)
      if (frame.ok) pending.resolve(frame.result)
      else pending.reject(new BridgeRequestError('rejected', String(frame.error ?? 'rejected')))
    }
  }

  private refuse(socket: Socket, reason: string): void {
    socket.destroy()
    this.emit('refused', { reason })
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }
}
