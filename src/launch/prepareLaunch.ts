// Everything the caller needs to spawn one observable Pi TUI.
//
// The caller still spawns the PTY itself (the package never owns a process,
// like its siblings) with exactly these args and env, then hands the PTY and
// this launch to PiTerminalHeadless — the opencode-terminal-headless
// `prepareOpencodeTerminalLaunch` slot.
//
// What it decides, and why:
//  - `--session-id <id>` for BOTH fresh and resumed sessions. Pi opens the
//    project's session with that id, or creates one with exactly that id
//    (Stage 0 H1), so the host knows the provider session id before the
//    process exists — no CLI round trip, no guessing a file later. The
//    one-line "creating a new session with that id" stderr warning on a fresh
//    id is harmless and accepted.
//  - `-e <bridge>`: the bridge extension, from wherever the host ships it.
//    Never installed into ~/.pi — the user's Pi config stays untouched.
//  - A fresh private 0700 directory under /tmp for the Unix socket, with a
//    short name: macOS limits socket paths to 104 bytes, and an overlong path
//    once crashed Pi from inside an extension (Stage 0). The HOST listens
//    there (PiTerminalHeadless.start); the extension only connects.
//  - A per-spawn random token, in env only — never argv, which `ps` shows.
//  - The session directory resolved with Pi's own precedence, so the durable
//    reader can find the file even if the bridge never connects.
//
// It spawns nothing and listens on nothing; `dispose()` removes the socket
// directory and is idempotent.

import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BRIDGE_SOCKET_ENV, BRIDGE_TOKEN_ENV } from '../bridge/protocol.js'
import { resolvePiSessionDir, resolvePiSessionFile } from './sessionPaths.js'

export type PiTerminalLaunch = {
  binary: string
  args: string[]
  env: Record<string, string>
  sessionId: string
  cwd: string
  /** Directory Pi writes this session into (Pi's own precedence). */
  sessionDir: string
  /** The existing session file when resuming, else null (a fresh session writes nothing until its first reply completes). */
  existingFile: string | null
  socketPath: string
  token: string
  dispose(): Promise<void>
}

export type PreparePiLaunchOptions = {
  binary: string
  cwd: string
  env: Record<string, string>
  /** The provider session id: freshly minted for a new pane, or the one being resumed. */
  sessionId: string
  /** Absolute path of the bridge extension file (src/bridge/extension.ts, shipped by the host). */
  bridgeScriptPath: string
  homeDirectory?: string
  /** Extra args the host wants (never identity/session flags — those are owned here). */
  extraArgs?: string[]
}

// Flags that would take over the identity or the session this launch owns.
// Refused rather than silently merged: a pane whose provider session id does
// not match the process it runs is the ownership bug class Agent Code keeps
// fixing elsewhere.
const OWNED_FLAGS = new Set(['--session', '--session-id', '--continue', '-c', '--resume', '-r', '--fork', '--no-session', '--session-dir', '--mode', '-p', '--print'])

function socketBase(): string {
  // WHY /tmp and not os.tmpdir(): macOS's per-user TMPDIR
  // (/var/folders/xx/…/T/) alone eats most of the 104-byte sun_path budget.
  // Windows has no /tmp and uses named pipes, which have no such limit.
  return process.platform === 'win32' ? tmpdir() : '/tmp'
}

export async function preparePiTerminalLaunch(options: PreparePiLaunchOptions): Promise<PiTerminalLaunch> {
  for (const arg of options.extraArgs ?? []) {
    const flag = arg.split('=')[0]!
    if (OWNED_FLAGS.has(flag)) throw new Error(`preparePiTerminalLaunch: ${flag} is owned by the launch and cannot be passed as an extra arg`)
  }
  const sessionDir = await resolvePiSessionDir({ env: options.env, cwd: options.cwd, ...(options.homeDirectory ? { homeDirectory: options.homeDirectory } : {}) })
  const existingFile = await resolvePiSessionFile({
    env: options.env,
    cwd: options.cwd,
    sessionId: options.sessionId,
    ...(options.homeDirectory ? { homeDirectory: options.homeDirectory } : {}),
  })
  const dir = await mkdtemp(join(socketBase(), 'acpi-'))
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\acpi-${randomBytes(8).toString('hex')}` : join(dir, 's')
  const token = randomBytes(24).toString('base64url')
  let disposed = false
  return {
    binary: options.binary,
    args: ['--session-id', options.sessionId, '-e', options.bridgeScriptPath, ...(options.extraArgs ?? [])],
    env: { ...options.env, [BRIDGE_SOCKET_ENV]: socketPath, [BRIDGE_TOKEN_ENV]: token },
    sessionId: options.sessionId,
    cwd: options.cwd,
    sessionDir,
    existingFile,
    socketPath,
    token,
    async dispose() {
      if (disposed) return
      disposed = true
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}
