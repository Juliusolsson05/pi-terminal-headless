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
//   - files are <ISO timestamp with : and . as ->_<sessionId>.jsonl, but a
//     session is IDENTIFIED by its header row, not its name (findById below);
//   - every configured path goes through Pi's normalizePath (tilde, file://
//     URL) and is otherwise used AS GIVEN: a relative one is relative to the
//     pi process's cwd (utils/paths.js resolvePath defaults to process.cwd()).
//
// Deliberately NOT modelled: a project-local `.pi/settings.json` sessionDir.
// Pi only honours project settings for trusted projects, and resolving trust
// here would duplicate Pi's trust store. The live channel reports the real
// file for running panes (bridge `session_start`), so this only affects cold
// reads of such projects; they fall back to "not found", never to a wrong file.

import { open, readdir, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'

export type PiPathEnvironment = {
  env: Record<string, string | undefined>
  homeDirectory?: string
}

function expandTilde(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

/**
 * A configured path as Pi resolves it: normalizePath (tilde, file:// URL),
 * then relative-to-`base`.
 *
 * WHY `base` is the pi process's cwd and never ours: Pi keeps a relative
 * `PI_CODING_AGENT_SESSION_DIR` / `sessionDir` setting / agent dir relative
 * and hands it straight to readdir / join, so it lands under pi's
 * process.cwd() — the PANE's project. `path.resolve` with no base would use
 * Agent Code's main-process cwd instead, and a provider switch would then
 * publish the imported conversation into a directory Pi never reads, so
 * `--session-id` starts an empty session (Astra review, finding 5).
 */
function resolvePiConfiguredPath(path: string, home: string, base: string): string {
  let normalized = expandTilde(path, home)
  if (/^file:\/\//.test(normalized)) normalized = fileURLToPath(normalized)
  return isAbsolute(normalized) ? resolve(normalized) : resolve(base, normalized)
}

/**
 * `cwd` is the pi process's cwd, used only to resolve a RELATIVE
 * `PI_CODING_AGENT_DIR`; callers that have no pane (the all-projects catalog)
 * omit it and get Pi's answer for a pi started in Agent Code's own cwd.
 */
export function resolvePiAgentDir({ env, homeDirectory }: PiPathEnvironment, cwd: string = process.cwd()): string {
  const home = homeDirectory ?? homedir()
  const fromEnv = env.PI_CODING_AGENT_DIR
  return fromEnv ? resolvePiConfiguredPath(fromEnv, home, cwd) : join(home, '.pi', 'agent')
}

export function encodeCwdForSessionDir(cwd: string): string {
  return `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
}

/** The global `sessionDir` setting from <agentDir>/settings.json, if any, as Pi resolves it. */
async function readSessionDirSetting(agentDir: string, home: string, base: string): Promise<string | undefined> {
  try {
    const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')) as { sessionDir?: unknown }
    return typeof settings.sessionDir === 'string' && settings.sessionDir ? resolvePiConfiguredPath(settings.sessionDir, home, base) : undefined
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
  return (await resolvePiSessionLocation(options)).dir
}

/**
 * The session directory plus what findById needs to know about it: whether
 * it is a CUSTOM directory (Pi then filters sessions by the header's cwd,
 * because a custom dir holds every project's files side by side) and the
 * resolved cwd to filter by.
 */
async function resolvePiSessionLocation(options: PiPathEnvironment & { cwd: string; sessionDirOverride?: string }): Promise<{ dir: string; custom: boolean; cwd: string }> {
  const home = options.homeDirectory ?? homedir()
  const cwd = await piProcessCwd(options.cwd)
  const agentDir = resolvePiAgentDir(options, cwd)
  const defaultDir = join(agentDir, 'sessions', encodeCwdForSessionDir(cwd))
  const fromEnv = options.env.PI_CODING_AGENT_SESSION_DIR
  const custom = options.sessionDirOverride
    ? resolvePiConfiguredPath(options.sessionDirOverride, home, cwd)
    : fromEnv
      ? resolvePiConfiguredPath(fromEnv, home, cwd)
      : await readSessionDirSetting(agentDir, home, cwd)
  // Pi: filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd).
  // A custom dir that happens to BE the default path behaves like the default.
  if (custom === undefined || custom === defaultDir) return { dir: defaultDir, custom: false, cwd }
  return { dir: custom, custom: true, cwd }
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
  // No pane here, so relative paths resolve against Agent Code's own cwd — see
  // listAllPiSessionFiles for why that result is not listed.
  const base = process.cwd()
  const fromEnv = options.env.PI_CODING_AGENT_SESSION_DIR
  if (fromEnv) return { root: resolvePiConfiguredPath(fromEnv, home, base), layout: 'flat' }
  const agentDir = resolvePiAgentDir(options, base)
  const fromSetting = await readSessionDirSetting(agentDir, home, base)
  if (fromSetting) return { root: fromSetting, layout: 'flat' }
  return { root: join(agentDir, 'sessions'), layout: 'per-cwd' }
}

/**
 * True when the configured session or agent directory is relative. Pi then
 * keeps a separate store under EACH project's cwd, which no single root can
 * enumerate; per-pane lookups (resolvePiSessionFile) still work because they
 * know the pane's cwd.
 */
async function hasRelativeSessionStore(options: PiPathEnvironment): Promise<boolean> {
  const home = options.homeDirectory ?? homedir()
  const isRelative = (path: string) => {
    const normalized = expandTilde(path, home)
    return !/^file:\/\//.test(normalized) && !isAbsolute(normalized)
  }
  const fromEnv = options.env.PI_CODING_AGENT_SESSION_DIR
  if (fromEnv) return isRelative(fromEnv)
  if (options.env.PI_CODING_AGENT_DIR && isRelative(options.env.PI_CODING_AGENT_DIR)) return true
  try {
    const settings = JSON.parse(await readFile(join(resolvePiAgentDir(options), 'settings.json'), 'utf8')) as { sessionDir?: unknown }
    return typeof settings.sessionDir === 'string' && settings.sessionDir !== '' && isRelative(settings.sessionDir)
  } catch {
    return false
  }
}

/** Every Pi session file under the sessions root, whichever layout it uses. */
export async function listAllPiSessionFiles(options: PiPathEnvironment): Promise<string[]> {
  // A relative store has no one location; listing Agent Code's own cwd would
  // show another directory's files as this user's Pi history.
  if (await hasRelativeSessionStore(options)) return []
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
 * The file holding session `sessionId` for this cwd, or null — Pi 0.87.1's
 * `SessionManager.findById` (session-manager.js), which `--session-id`,
 * `--session <id>` and `/resume` all go through.
 *
 * WHY the HEADER decides, not the file name: Pi never looks at names. It
 * walks the directory in readdir order and returns the first `.jsonl` whose
 * first session row carries the id (and, in a custom flat dir, whose header
 * cwd is this cwd). A file renamed or copied by hand (`conversation.jsonl`) is
 * a session Pi resumes; an earlier version of this function matched names
 * only, so the app showed such a conversation as empty and a provider switch
 * out of it lost the history (Astra review, finding 6). An earlier comment
 * here claimed `--session-id` looked sessions up by name; that was wrong.
 *
 * WHY still a name-first pass: every file Pi itself creates is
 * `<ts>_<id>.jsonl`, so the likely candidate is known without opening
 * hundreds of headers on the history-load hot path. The name is only a hint —
 * the candidate's header must confirm the id — and the full header scan runs
 * when it does not. Candidates are taken in readdir order, like Pi; the one
 * case this can still disagree with Pi is a hand-made copy under a DIFFERENT
 * name that readdir lists before the original, which no Pi command produces.
 */
export async function resolvePiSessionFile(options: PiPathEnvironment & { cwd: string; sessionId: string; sessionDirOverride?: string }): Promise<string | null> {
  const { dir, custom, cwd } = await resolvePiSessionLocation(options)
  let names: string[]
  try {
    names = (await readdir(dir)).filter(name => name.endsWith('.jsonl'))
  } catch {
    return null
  }
  const matches = async (name: string): Promise<boolean> => {
    const header = await readSessionHeaderForDiscovery(join(dir, name))
    if (header?.id !== options.sessionId) return false
    if (!custom) return true
    const headerCwd = typeof header.cwd === 'string' ? header.cwd : ''
    // Pi: sessionCwdMatches — resolvePath(header.cwd) === resolvePath(cwd).
    return headerCwd !== '' && resolve(cwd, headerCwd) === cwd
  }
  const hinted = names.filter(name => sessionIdFromFileName(name) === options.sessionId)
  for (const name of hinted) if (await matches(name)) return join(dir, name)
  for (const name of names) {
    if (hinted.includes(name)) continue
    if (await matches(name)) return join(dir, name)
  }
  return null
}

// Pi bounds header discovery at 1 MiB (MAX_SESSION_HEADER_SCAN_BYTES).
const MAX_HEADER_SCAN_BYTES = 1024 * 1024

/**
 * The first parsed row of a session file if it is a session header, else
 * null — Pi's readSessionHeader: blank and malformed lines are skipped, the
 * first parsed row that is NOT a header means "not a session", and anything
 * unreadable is simply not a session (discovery is best-effort).
 */
async function readSessionHeaderForDiscovery(file: string): Promise<{ id?: unknown; cwd?: unknown } | null> {
  let handle
  try {
    handle = await open(file, 'r')
  } catch {
    return null
  }
  try {
    const decoder = new StringDecoder('utf8')
    const buffer = Buffer.alloc(4096)
    let pending = ''
    let scanned = 0
    const candidate = (line: string): { id?: unknown; cwd?: unknown } | null | undefined => {
      if (!line.trim()) return undefined
      let row: unknown
      try {
        row = JSON.parse(line)
      } catch {
        return undefined
      }
      const record = row as { type?: unknown; id?: unknown; cwd?: unknown } | null
      return record && record.type === 'session' && typeof record.id === 'string' ? record : null
    }
    while (scanned < MAX_HEADER_SCAN_BYTES) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) return candidate(pending + decoder.end()) ?? null
      scanned += bytesRead
      pending += decoder.write(buffer.subarray(0, bytesRead))
      let newline: number
      while ((newline = pending.indexOf('\n')) >= 0) {
        const found = candidate(pending.slice(0, newline))
        pending = pending.slice(newline + 1)
        if (found !== undefined) return found
      }
    }
    return null
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}
