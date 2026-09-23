import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadLiveFixture, toJsonl } from '../testing/fixtures.js'
import { referenceActiveBranch } from '../testing/oracle.js'
import { listPiSessionFiles, PiHistoryError, readPiBranch, readPiHistory, summarizePiSession } from './history.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function materialize(scenario: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'pi-history-'))
  dirs.push(dir)
  return Object.entries(loadLiveFixture(scenario).files).map(([path, rows]) => {
    const file = join(dir, path.split('/').at(-1)!)
    writeFileSync(file, toJsonl(rows))
    return file
  })
}

describe('readPiHistory', () => {
  it('pages the active branch newest-first, never returning an abandoned turn', async () => {
    const [file] = materialize('tree')
    const expected = referenceActiveBranch(Object.values(loadLiveFixture('tree').files)[0]!).map(row => row.id)
    const pages: string[][] = []
    let before: string | undefined
    for (;;) {
      const page = await readPiHistory(file!, { limit: 2, ...(before ? { beforeEntryId: before } : {}) })
      pages.unshift(page.rows.map(row => row.id))
      if (!page.hasOlder) break
      before = page.rows[0]!.id
    }
    expect(pages.flat()).toEqual(expected)
    expect(pages.at(-1)).toHaveLength(2)
  })

  it('an anchor that is no longer on the branch yields nothing rather than a mixed history', async () => {
    const [file] = materialize('tree')
    const rows = Object.values(loadLiveFixture('tree').files)[0]!
    const branch = new Set(referenceActiveBranch(rows).map(row => row.id))
    const abandoned = rows.find(row => row.type === 'message' && !branch.has(row.id as string))!
    expect(await readPiHistory(file!, { limit: 10, beforeEntryId: abandoned.id as string })).toEqual({ rows: [], hasOlder: false })
  })

  it('distinguishes "cannot read" from "empty": a missing file and a non-session file throw typed errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-history-'))
    dirs.push(dir)
    await expect(readPiHistory(join(dir, 'missing.jsonl'), { limit: 5 })).rejects.toMatchObject({ code: 'not_found' })
    writeFileSync(join(dir, 'x.jsonl'), '{"hello":1}\n')
    await expect(readPiBranch(join(dir, 'x.jsonl'))).rejects.toBeInstanceOf(PiHistoryError)
  })
})

describe('summarizePiSession / listPiSessionFiles', () => {
  it('summarizes the branch Pi would resume: first prompts, prompt count, fork parent', async () => {
    const files = materialize('fork')
    const listed = await listPiSessionFiles(join(files[0]!, '..'))
    expect(listed).toEqual([...files].sort())
    const [parent, child] = [...files].sort()
    const summary = await summarizePiSession(child!)
    expect(summary.parentSession).toBeDefined()
    // Forking AT a user message puts that message's text back into Pi's
    // editor (like /tree), so the probe's next typed prompt was appended to
    // it — the recorded user row is the concatenation. That is Pi behavior,
    // and it is why a fork's first new prompt is not assumed to be new text.
    expect(summary.firstUserTexts).toEqual(['first [probe:f1]', 'second [probe:f2]in the fork [probe:f3]'])
    expect(summary.promptCount).toBe(2)
    expect((await summarizePiSession(parent!)).promptCount).toBe(2)
  })
})
