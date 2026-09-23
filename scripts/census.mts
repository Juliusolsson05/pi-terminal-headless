// Read-only census over a directory of Pi session files.
//
// Usage:
//   npm run census -- --sessions ~/.pi/agent/sessions        (or any copy of it)
//
// WHY: the reader tolerates unknown entry types, roles and versions instead of
// failing, which means drift is SILENT at runtime. This census is how a human
// accepting a new Pi release (support/README.md) sees what a real session
// directory actually contains: counts of every entry type, message role,
// stopReason and header version, plus the one structural invariant the
// reader relies on (a parent always precedes its child in the file) and how
// many files carry abandoned branches.
//
// It never writes, never copies content, and prints counts only — safe to run
// over a user's real sessions.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

function parseArgs(argv: string[]): { sessions: string } {
  const index = argv.indexOf('--sessions')
  const sessions = index >= 0 ? argv[index + 1] : undefined
  if (!sessions) throw new Error('--sessions <dir> is required')
  return { sessions }
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (name.endsWith('.jsonl')) yield full
  }
}

const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1)

function main(): void {
  const { sessions } = parseArgs(process.argv.slice(2))
  const types = new Map<string, number>()
  const roles = new Map<string, number>()
  const stopReasons = new Map<string, number>()
  const versions = new Map<string, number>()
  let files = 0
  let rowsTotal = 0
  let unparsable = 0
  let parentAfterChild = 0
  let withAbandoned = 0
  let forked = 0
  for (const file of walk(sessions)) {
    files += 1
    const rows: Array<Record<string, any>> = []
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        rows.push(JSON.parse(line))
      } catch {
        unparsable += 1
      }
    }
    rowsTotal += rows.length
    const header = rows.find(row => row.type === 'session')
    bump(versions, String(header?.version ?? 1))
    if (header?.parentSession) forked += 1
    const seen = new Set<string>()
    const parents = new Set<string>()
    for (const row of rows) {
      bump(types, String(row.type))
      if (row.type === 'message') {
        bump(roles, String(row.message?.role))
        if (row.message?.role === 'assistant') bump(stopReasons, String(row.message?.stopReason))
      }
      if (row.type === 'session' || typeof row.id !== 'string') continue
      if (row.parentId && !seen.has(row.parentId)) parentAfterChild += 1
      if (row.parentId) parents.add(row.parentId)
      seen.add(row.id)
    }
    // Leaves other than the last row = abandoned branches (from /tree).
    const entries = rows.filter(row => row.type !== 'session' && typeof row.id === 'string')
    const leaves = entries.filter(row => !parents.has(row.id))
    if (leaves.length > 1) withAbandoned += 1
  }
  const table = (map: Map<string, number>) => Object.fromEntries([...map].sort((a, b) => b[1] - a[1]))
  console.log(JSON.stringify({
    files,
    rows: rowsTotal,
    unparsableLines: unparsable,
    headerVersions: table(versions),
    entryTypes: table(types),
    messageRoles: table(roles),
    assistantStopReasons: table(stopReasons),
    invariantParentBeforeChildViolations: parentAfterChild,
    filesWithAbandonedBranches: withAbandoned,
    forkedFiles: forked,
  }, null, 2))
}

main()
