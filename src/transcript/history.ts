// Cold reads of a Pi session: history pages for a parked/restarted pane, the
// full active branch for MCP transcript tools and provider switching, and a
// listing for the conversation catalog.
//
// Every read here resolves the branch the way Pi does ON LOAD — from the last
// row in the file (research H6) — because that is the conversation the user
// gets back when this session is resumed. A live /tree move that has not
// written a row yet is invisible here by design: the live channel owns it.
//
// Whole-file reads are deliberate. The branch can only be resolved with the
// entire tree in hand (a parent can be anywhere above its child), and Pi
// itself reads the whole file to load a session; these reads happen on
// history load and MCP calls, not per keystroke.

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { TreeIndex } from './ActiveBranch.js'
import { isMessageRow, parseSessionText, type PiSessionHeader, type PiSessionRow } from './SessionFile.js'
import { sessionIdFromFileName } from '../launch/sessionPaths.js'

export type PiHistoryPage = {
  /** Oldest first. */
  rows: PiSessionRow[]
  /** True when rows older than the first returned row exist on the branch. */
  hasOlder: boolean
}

export class PiHistoryError extends Error {
  constructor(readonly code: 'not_found' | 'unreadable' | 'not_a_session', message: string) {
    super(message)
    this.name = 'PiHistoryError'
  }
}

async function loadBranch(file: string): Promise<{ header: PiSessionHeader; branch: PiSessionRow[] }> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'unreadable'
    throw new PiHistoryError(code, `${code}: ${(error as Error).message}`)
  }
  const { header, rows } = parseSessionText(text)
  // WHY "no rows" is fine but "no header" is an error: a Pi file always
  // starts with its header; without one this is not a session file, and
  // reporting it as an empty conversation would be a lie (the OpenCode
  // Terminal review lesson: "could not read" ≠ "empty").
  if (!header) throw new PiHistoryError('not_a_session', `not a Pi session file: ${file}`)
  const index = new TreeIndex()
  for (const row of rows) index.add(row)
  return { header, branch: index.branch() }
}

/**
 * One page of the active branch, newest-first paging, rows returned oldest
 * first. `beforeEntryId` is the oldest row id the caller already holds.
 */
export async function readPiHistory(file: string, options: { limit: number; beforeEntryId?: string }): Promise<PiHistoryPage> {
  const { branch } = await loadBranch(file)
  let end = branch.length
  if (options.beforeEntryId !== undefined) {
    const index = branch.findIndex(row => row.id === options.beforeEntryId)
    // An id no longer on the branch (the user moved in the tree since the
    // caller's last page) cannot anchor a page; there is nothing older to
    // give that would be consistent with what the caller holds.
    if (index === -1) return { rows: [], hasOlder: false }
    end = index
  }
  const start = Math.max(0, end - Math.max(0, options.limit))
  return { rows: branch.slice(start, end), hasOlder: start > 0 }
}

/** The whole active branch, oldest first (MCP transcript reads, provider switch). */
export async function readPiBranch(file: string): Promise<{ header: PiSessionHeader; rows: PiSessionRow[] }> {
  const { header, branch } = await loadBranch(file)
  return { header, rows: branch }
}

export type PiSessionSummary = {
  file: string
  sessionId: string
  cwd: string
  createdAt: string
  parentSession?: string
  /** `session_info` name on the active branch, newest wins. */
  name?: string
  /** First user texts on the active branch (bounded). */
  firstUserTexts: string[]
  /** Number of user messages on the active branch. */
  promptCount: number
  /** ISO timestamp of the last row on the branch, else the header timestamp. */
  lastActivityAt: string
  mtimeMs: number
}

function userText(row: PiSessionRow): string | undefined {
  if (!isMessageRow(row) || row.message.role !== 'user') return undefined
  const content = row.message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  return content.map(block => (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' ? String((block as { text?: unknown }).text ?? '') : '')).join('')
}

export async function summarizePiSession(file: string, options: { maxUserTexts?: number } = {}): Promise<PiSessionSummary> {
  const [{ header, branch }, info] = await Promise.all([loadBranch(file), stat(file)])
  const texts: string[] = []
  let name: string | undefined
  let promptCount = 0
  for (const row of branch) {
    if (row.type === 'session_info' && typeof row.name === 'string') name = row.name
    const text = userText(row)
    if (text !== undefined) {
      promptCount += 1
      if (texts.length < (options.maxUserTexts ?? 3)) texts.push(text)
    }
  }
  const last = branch.at(-1)
  return {
    file,
    sessionId: header.id,
    cwd: header.cwd,
    createdAt: header.timestamp,
    ...(typeof header.parentSession === 'string' ? { parentSession: header.parentSession } : {}),
    ...(name !== undefined ? { name } : {}),
    firstUserTexts: texts,
    promptCount,
    lastActivityAt: typeof last?.timestamp === 'string' ? last.timestamp : header.timestamp,
    mtimeMs: info.mtimeMs,
  }
}

/** Every session file directly inside `sessionDir` (one project's dir, or a flat custom dir). */
export async function listPiSessionFiles(sessionDir: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(sessionDir)
  } catch {
    return []
  }
  return names.filter(name => sessionIdFromFileName(name) !== undefined).sort().map(name => join(sessionDir, name))
}
