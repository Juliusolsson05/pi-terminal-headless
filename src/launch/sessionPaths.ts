// Where Pi keeps a project's sessions — resolved exactly as the pinned Pi
// release resolves it, because a mismatch means Agent Code shows an empty
// history for a conversation that exists.
//
// Source of truth (earendil-works/pi@96724621, packages/coding-agent):
//   - agent dir: $PI_CODING_AGENT_DIR (tilde-expanded) or ~/.pi/agent
//     (config.ts getAgentDir);
//   - session dir precedence: --session-dir > $PI_CODING_AGENT_SESSION_DIR >
//     the `sessionDir` setting > default (main.ts);
//   - a CUSTOM session dir is used flat — every project's files side by side
//     (SessionManager.create(cwd, sessionDir));
//   - the DEFAULT is <agentDir>/sessions/--<cwd with the leading separator
//     removed and / \ : replaced by ->--/ (getDefaultSessionDirPath);
//   - files are <ISO timestamp with : and . as ->_<sessionId>.jsonl.
//
// Deliberately NOT modelled: a project-local `.pi/settings.json` sessionDir.
// Pi only honours project settings for trusted projects, and resolving trust
// here would duplicate Pi's trust store. The live channel reports the real
// file for running panes (bridge `session_start`), so this only affects cold
// reads of such projects; they fall back to "not found", never to a wrong file.

import { readdir, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export type PiPathEnvironment = {
  env: Record<string, string | undefined>
  homeDirectory?: string
}

function expandTilde(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

export function resolvePiAgentDir({ env, homeDirectory }: PiPathEnvironment): string {
  const home = homeDirectory ?? homedir()
  const fromEnv = env.PI_CODING_AGENT_DIR
  return fromEnv ? resolve(expandTilde(fromEnv, home)) : join(home, '.pi', 'agent')
}

export function encodeCwdForSessionDir(cwd: string): string {
  return `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
}

/** The global `sessionDir` setting from <agentDir>/settings.json, if any. */
async function readSessionDirSetting(agentDir: string, home: string): Promise<string | undefined> {
  try {
    const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')) as { sessionDir?: unknown }
    return typeof settings.sessionDir === 'string' && settings.sessionDir ? resolve(expandTilde(settings.sessionDir, home)) : undefined
  } catch {
    // No settings file (the common case) or an unreadable one: Pi falls back
    // to its default too.
    return undefined
  }
}

/**
 * The directory Pi writes this cwd's sessions into.
 * `sessionDirOverride` is what the launch passed as --session-dir, if anything.
 */
export async function resolvePiSessionDir(options: PiPathEnvironment & { cwd: string; sessionDirOverride?: string }): Promise<string> {
  const home = options.homeDirectory ?? homedir()
  if (options.sessionDirOverride) return resolve(expandTilde(options.sessionDirOverride, home))
  const fromEnv = options.env.PI_CODING_AGENT_SESSION_DIR
  if (fromEnv) return resolve(expandTilde(fromEnv, home))
  const agentDir = resolvePiAgentDir(options)
  const fromSetting = await readSessionDirSetting(agentDir, home)
  if (fromSetting) return fromSetting
  return join(agentDir, 'sessions', encodeCwdForSessionDir(await piProcessCwd(options.cwd)))
}

/**
 * The cwd as the `pi` process will see it.
 *
 * WHY realpath: Pi encodes `process.cwd()` (main.js), and Node reports the
 * RESOLVED directory, symlinks followed. A pane whose cwd is a symlinked path
 * (any project under macOS `/tmp`, a symlinked checkout) otherwise resolves to
 * `--tmp-x--` while pi wrote `--private-tmp-x--`, and history, switching and
 * the catalog all report an existing conversation as missing. A cwd that does
 * not exist cannot be a pi process's cwd, so `resolve` is only a fallback that
 * keeps lookups total.
 */
export async function piProcessCwd(cwd: string): Promise<string> {
  return realpath(cwd).catch(() => resolve(cwd))
}

/**
 * Where ALL of this user's Pi sessions live, for listing every project at once
 * (Agent Code's conversation catalog). The default keeps one directory per cwd
 * under `<agentDir>/sessions`; a custom session dir (env or setting) is flat.
 *
 * WHY the layout is reported rather than hidden: the per-cwd directory name is
 * a LOSSY encoding of the cwd (`/` and `-` both become `-`), so a lister must
 * read each file's header for the real cwd; knowing the layout tells it where
 * the files are, not which project they belong to.
 */
export async function resolvePiSessionsRoot(options: PiPathEnvironment): Promise<{ root: string; layout: 'per-cwd' | 'flat' }> {
  const home = options.homeDirectory ?? homedir()
  const fromEnv = options.env.PI_CODING_AGENT_SESSION_DIR
  if (fromEnv) return { root: resolve(expandTilde(fromEnv, home)), layout: 'flat' }
  const agentDir = resolvePiAgentDir(options)
  const fromSetting = await readSessionDirSetting(agentDir, home)
  if (fromSetting) return { root: fromSetting, layout: 'flat' }
  return { root: join(agentDir, 'sessions'), layout: 'per-cwd' }
}

/** Every Pi session file under the sessions root, whichever layout it uses. */
export async function listAllPiSessionFiles(options: PiPathEnvironment): Promise<string[]> {
  const { root, layout } = await resolvePiSessionsRoot(options)
  const directories = layout === 'flat' ? [root] : await readdir(root).then(names => names.map(name => join(root, name)), () => [])
  const files: string[] = []
  for (const directory of directories) {
    let names: string[]
    try {
      names = await readdir(directory)
    } catch {
      continue // a stray file in the root, or a directory removed meanwhile
    }
    for (const name of names) if (sessionIdFromFileName(name) !== undefined) files.push(join(directory, name))
  }
  return files.sort()
}

/** `<ts>_<id>.jsonl` → id, or undefined for any other name. */
export function sessionIdFromFileName(name: string): string | undefined {
  const match = /^[^_]+_(.+)\.jsonl$/.exec(name)
  return match?.[1]
}

/**
 * The file holding session `sessionId` for this cwd, or null.
 *
 * WHY match the file NAME: Pi names every file it creates `<ts>_<id>.jsonl`
 * (new, /new, fork, clone), and `--session-id` looks sessions up the same way
 * for this project. Reading every header instead would cost a file open per
 * session on a hot path (history load on restart).
 */
export async function resolvePiSessionFile(options: PiPathEnvironment & { cwd: string; sessionId: string; sessionDirOverride?: string }): Promise<string | null> {
  const dir = await resolvePiSessionDir(options)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return null
  }
  const matches = names.filter(name => sessionIdFromFileName(name) === options.sessionId).sort()
  // Two files for one id cannot come from Pi itself; if a user copied one,
  // the newest timestamp prefix is the one Pi's own lookup would reach last.
  const chosen = matches.at(-1)
  return chosen ? join(dir, chosen) : null
}
