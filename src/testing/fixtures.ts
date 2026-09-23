// Test-only loaders for the Stage 0 recordings (excluded from the build by
// tsconfig.build.json). Every durable/live test reads fixtures through here so
// the on-disk shape is declared once, next to the code that depends on it.
//
// WHY recordings and not hand-written literals: the reader's rules were
// derived from what Pi actually wrote and fired (research/census-2026-09-22.md).
// A literal typed into a test encodes the author's belief about that shape; a
// recording encodes the shape itself.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// WHY not simply fileURLToPath(import.meta.url): hosts run the replay harness
// from DOM-emulating test projects (Agent Code's renderer tests under
// happy-dom), where Vite rewrites `import.meta.url` to an http URL whose path
// is `/@fs/<absolute path>` or project-relative. Copied from
// opencode-terminal-headless, which hit this first.
function resolveFixtureRoot(): string {
  const here = new URL('../../testing/fixtures/', import.meta.url)
  if (here.protocol === 'file:') return fileURLToPath(here)
  const pathname = decodeURIComponent(here.pathname)
  const candidates = pathname.startsWith('/@fs/') ? [pathname.slice('/@fs'.length)] : [pathname, join(process.cwd(), pathname)]
  const found = candidates.find(candidate => existsSync(candidate))
  if (!found) throw new Error(`cannot locate pi-terminal-headless fixtures from ${here.href}`)
  return found.endsWith('/') ? found : `${found}/`
}

const FIXTURE_ROOT = resolveFixtureRoot()

/** One JSONL row exactly as Pi wrote it (system prompt text replaced by lengths). */
export type RecordedRow = Record<string, unknown> & { type: string; id?: string; parentId?: string | null }

/** One extension event as the recorder saw it inside pi. */
export type RecordedEvent = Record<string, unknown> & {
  /** ms since the probe started */
  t: number
  /** extension event name, or a probe_* marker written by the recorder */
  name: string
  /** size of the session file at the moment the handler ran; -1 = not created yet */
  fileBytes?: number
  sessionFile?: string
  sessionId?: string
  leafId?: string
  idle?: boolean
  pending?: boolean
}

export type LiveFixture = {
  meta: { recordedWith: string; scenario: string; recordedAt: string; node: string; platform: string; terminal: string; cols: number; rows: number }
  /** the uuid passed as --session-id to the first process */
  sessionIdLaunched: string | null
  notes: string[]
  steps: Array<{ t: number; action: string; detail?: unknown }>
  events: RecordedEvent[]
  /** host-side 10 ms stat poll of every session file */
  growth: Array<{ t: number; file: string; bytes: number }>
  exits: Array<{ t: number; process: number; exitCode: number; signal?: number }>
  pty: { chunks: number; bytes: number; da1HandAnswered: number; screen: string[] }
  /** every session file at the end of the scenario, keyed by its normalized path */
  files: Record<string, RecordedRow[]>
  /** original on-disk byte length of each row (line + newline), same order as files[path] */
  fileRowBytes: Record<string, number[]>
}

export function fixturePath(relative: string): string {
  return `${FIXTURE_ROOT}${relative}`
}

export function listLiveFixtures(): string[] {
  return readdirSync(fixturePath('live')).filter(name => name.endsWith('.json')).sort()
}

export function loadLiveFixture(name: string): LiveFixture {
  return JSON.parse(readFileSync(fixturePath(`live/${name.endsWith('.json') ? name : `${name}.json`}`), 'utf8')) as LiveFixture
}

/** Serialize rows back to the bytes a JSONL file would hold (one row per line). */
export function toJsonl(rows: readonly RecordedRow[]): string {
  return rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '')
}

export function listDurableFixtures(): string[] {
  const dir = fixturePath('durable')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort()
}

export function loadDurableFixtureText(name: string): string {
  return readFileSync(fixturePath(`durable/${name}`), 'utf8')
}
