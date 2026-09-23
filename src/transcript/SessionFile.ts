// The ONLY module that knows the shape of Pi's session JSONL.
//
// WHY one owner: every other layer (the tailer, the branch projection, the
// sequencer, Agent Code's mapper) consumes `PiSessionRow`s produced here. When
// Pi changes its format — it ships breaking changes in 0.x minors (0.87.0 added
// `context_edit`) — this is the one file whose tests must move with it
// (support/upstream-versions.json lists the coupling).
//
// Tolerance policy: a row this module does not recognise is KEPT and passed
// through as an opaque row, never dropped and never an error. Dropping would
// silently shorten a conversation; erroring would kill the live channel over
// a harmless new entry type. Only lines that are not JSON objects are errors.
//
// Versions (research/census-2026-09-22.md, H10):
//   v3 (current) — tree: every non-header row has `id` + `parentId`.
//   v2 — same tree; message role `hookMessage` later renamed to `custom`.
//   v1 — a LINEAR list: rows have no `id`/`parentId`; the header has no
//        `version` and carries provider/modelId/thinkingLevel.
// Pi migrates v1/v2 IN PLACE when it loads such a file (`migrateToCurrentVersion`
// rewrites it), so a reader can see an old file only until pi opens it. We
// normalise the same way Pi does — synthesising a linear chain for v1 and
// mapping `hookMessage` → `custom` — so every consumer sees one shape.

export const CURRENT_SESSION_VERSION = 3

export type PiSessionHeader = {
  type: 'session'
  version: number
  id: string
  timestamp: string
  cwd: string
  parentSession?: string
  [key: string]: unknown
}

/** Any non-header row after normalisation: always has an id and a parentId. */
export type PiSessionRow = {
  type: string
  id: string
  parentId: string | null
  timestamp?: string
  /** 0-based physical line index in the file (header = line 0). Stable rewind/paging address. */
  line: number
  [key: string]: unknown
}

export type PiMessage = {
  role: string
  content?: unknown
  timestamp?: number
  stopReason?: string
  errorMessage?: string
  [key: string]: unknown
}

export type PiMessageRow = PiSessionRow & { type: 'message'; message: PiMessage }

export class SessionFileError extends Error {
  constructor(
    readonly code: 'invalid_json' | 'not_an_object' | 'missing_header',
    message: string,
    readonly line: number,
  ) {
    super(message)
    this.name = 'SessionFileError'
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Parse one JSONL line. Throws SessionFileError for non-JSON / non-object lines. */
export function parseLine(text: string, line: number): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new SessionFileError('invalid_json', `line ${line}: ${(error as Error).message}`, line)
  }
  if (!isObject(value)) throw new SessionFileError('not_an_object', `line ${line}: not a JSON object`, line)
  return value
}

export function isHeader(value: Record<string, unknown>): value is PiSessionHeader {
  return value.type === 'session' && typeof value.id === 'string'
}

export function headerVersion(header: PiSessionHeader): number {
  return typeof header.version === 'number' ? header.version : 1
}

export function isMessageRow(row: PiSessionRow): row is PiMessageRow {
  return row.type === 'message' && isObject(row.message) && typeof (row.message as { role?: unknown }).role === 'string'
}

export function messageRole(row: PiSessionRow): string | undefined {
  return isMessageRow(row) ? row.message.role : undefined
}

/**
 * Incremental normaliser: feed raw objects in file order, get rows back.
 *
 * WHY incremental and stateful: the tailer sees a file a few lines at a time,
 * and v1 normalisation needs the previous row's synthetic id to chain the
 * next one. The header (line 0) decides the version for the whole file.
 */
export class SessionRowNormalizer {
  private header: PiSessionHeader | undefined
  private version = CURRENT_SESSION_VERSION
  private previousId: string | null = null

  getHeader(): PiSessionHeader | undefined {
    return this.header
  }

  /** Returns the header (for line 0) or a normalised row. */
  push(raw: Record<string, unknown>, line: number): { header: PiSessionHeader } | { row: PiSessionRow } {
    if (isHeader(raw)) {
      this.header = raw
      this.version = headerVersion(raw)
      this.previousId = null
      return { header: raw }
    }
    if (!this.header) {
      // Pi always writes the header first (it opens a new file with `wx` and
      // writes everything so far at once). A row before any header means we
      // are not reading a Pi session file.
      throw new SessionFileError('missing_header', `line ${line}: row before the session header`, line)
    }
    let row: PiSessionRow
    if (this.version < 2 || typeof raw.id !== 'string') {
      // v1: a linear list. Synthesise ids that cannot collide with Pi's 8-hex
      // ids and that stay stable across re-reads (line-based), and chain each
      // row to the previous one — exactly Pi's own migrateV1ToV2 shape.
      const id = `v1-${line}`
      row = { ...raw, type: String(raw.type), id, parentId: this.previousId, line }
    } else {
      row = {
        ...raw,
        type: String(raw.type),
        id: raw.id as string,
        parentId: typeof raw.parentId === 'string' ? raw.parentId : null,
        line,
      }
    }
    if (this.version < 3 && isMessageRow(row) && row.message.role === 'hookMessage') {
      row = { ...row, message: { ...row.message, role: 'custom' } }
    }
    this.previousId = row.id
    return { row }
  }
}

/** Parse a whole file's text. Unparsable lines are reported, not fatal. */
export function parseSessionText(text: string): { header: PiSessionHeader | undefined; rows: PiSessionRow[]; errors: SessionFileError[] } {
  const normalizer = new SessionRowNormalizer()
  const rows: PiSessionRow[] = []
  const errors: SessionFileError[] = []
  const lines = text.split('\n')
  // split('\n') leaves either '' (text ended with a newline) or an
  // unterminated line Pi is still writing — or a crash mid-write — as the last
  // element. Either way it is not a committed row.
  const complete = lines.slice(0, -1)
  complete.forEach((lineText, line) => {
    if (!lineText.trim()) return
    try {
      const result = normalizer.push(parseLine(lineText, line), line)
      if ('row' in result) rows.push(result.row)
    } catch (error) {
      if (error instanceof SessionFileError) errors.push(error)
      else throw error
    }
  })
  return { header: normalizer.getHeader(), rows, errors }
}
