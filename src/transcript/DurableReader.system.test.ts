import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadLiveFixture, type RecordedRow } from '../testing/fixtures.js'
import { DurableReader } from './DurableReader.js'
import type { PiSessionRow } from './SessionFile.js'

// System tier: a real file on disk, written the way Pi writes it (everything
// at once when the first reply completes, then one appended line per row),
// read by the real tailer. Rows come from recordings, never literals.

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-durable-'))
  dirs.push(dir)
  return join(dir, 'session.jsonl')
}

function collect(file: string) {
  const rows: PiSessionRow[] = []
  const resets: string[] = []
  const errors: Error[] = []
  const headers: string[] = []
  const reader = new DurableReader(file, {
    onRows: batch => rows.push(...batch),
    onHeader: header => headers.push(header.id),
    onReset: reason => resets.push(reason),
    onError: error => errors.push(error),
  }, { fastPollMs: 10_000, slowPollMs: 10_000 }) // doorbell-driven only: no timer help
  return { reader, rows, resets, errors, headers }
}

const line = (row: RecordedRow) => `${JSON.stringify(row)}\n`

describe('DurableReader', () => {
  it('waits for a file that does not exist yet, then reads everything Pi wrote at once, then each append', async () => {
    const [recorded] = Object.values(loadLiveFixture('tool').files)
    const file = tempFile()
    const { reader, rows, errors, headers } = collect(file)
    reader.start()
    await reader.ring()
    expect(rows).toEqual([]) // absent file = no reply completed yet, not an error
    expect(errors).toEqual([])

    // Pi's first write: header + everything up to the first completed reply.
    const firstAssistant = recorded!.findIndex(row => (row.message as { role?: string } | undefined)?.role === 'assistant')
    writeFileSync(file, recorded!.slice(0, firstAssistant + 1).map(line).join(''))
    await reader.ring()
    for (const row of recorded!.slice(firstAssistant + 1)) {
      appendFileSync(file, line(row))
      await reader.ring()
    }
    await reader.stop()
    expect(headers).toEqual([recorded![0]!.id])
    expect(rows.map(row => row.id)).toEqual(recorded!.slice(1).map(row => row.id))
    expect(rows.map(row => row.line)).toEqual(recorded!.slice(1).map((_, i) => i + 1))
  })

  it('holds a row split across writes — including inside a multi-byte character — until its newline lands', async () => {
    const [recorded] = Object.values(loadLiveFixture('plain').files)
    const file = tempFile()
    const { reader, rows, errors } = collect(file)
    writeFileSync(file, recorded!.map(line).join(''))
    await reader.ring()
    const extra = { type: 'message', id: 'ffff0001', parentId: recorded!.at(-1)!.id, timestamp: 't', message: { role: 'user', content: [{ type: 'text', text: 'π — naïve ✓' }] } }
    const bytes = Buffer.from(line(extra))
    const cut = bytes.indexOf(Buffer.from('π')) + 1 // inside the 2-byte π
    appendFileSync(file, bytes.subarray(0, cut))
    await reader.ring()
    expect(rows.at(-1)!.id).not.toBe('ffff0001')
    appendFileSync(file, bytes.subarray(cut))
    await reader.ring()
    await reader.stop()
    expect(errors).toEqual([])
    expect(((rows.at(-1)!.message as { content: Array<{ text: string }> }).content[0]!.text)).toBe('π — naïve ✓')
  })

  it('treats a replaced or truncated file as a new generation and re-reads it from the start', async () => {
    const [recorded] = Object.values(loadLiveFixture('tool').files)
    const file = tempFile()
    const { reader, rows, resets } = collect(file)
    writeFileSync(file, recorded!.map(line).join(''))
    await reader.ring()
    // Pi's in-place migration rewrite: a new inode with (here) fewer rows.
    const replacement = `${file}.tmp`
    writeFileSync(replacement, recorded!.slice(0, 4).map(line).join(''))
    renameSync(replacement, file)
    await reader.ring()
    // An in-place truncate keeps the inode but shrinks.
    writeFileSync(file, recorded!.slice(0, 3).map(line).join(''))
    await reader.ring()
    await reader.stop()
    expect(resets).toEqual(['replaced', 'truncated'])
    const all = rows.map(row => row.id)
    const firstPass = recorded!.slice(1).map(row => row.id)
    expect(all).toEqual([...firstPass, ...recorded!.slice(1, 4).map(row => row.id), ...recorded!.slice(1, 3).map(row => row.id)])
  })

  it('retarget drops the old file and follows the new one (a /new switch whose file appears later)', async () => {
    const fixture = loadLiveFixture('new-session')
    const [first, second] = Object.values(fixture.files)
    const fileA = tempFile()
    const fileB = tempFile()
    const { reader, rows } = collect(fileA)
    writeFileSync(fileA, first!.map(line).join(''))
    await reader.ring()
    reader.retarget(fileB)
    await reader.ring()
    appendFileSync(fileA, line({ type: 'message', id: 'late0001', parentId: first!.at(-1)!.id, message: { role: 'user', content: 'late' } }))
    writeFileSync(fileB, second!.map(line).join(''))
    await reader.ring()
    await reader.stop()
    expect(rows.map(row => row.id)).toEqual([...first!.slice(1), ...second!.slice(1)].map(row => row.id))
  })

  it('reports a corrupt line without stopping, and survives a consumer that throws', async () => {
    const [recorded] = Object.values(loadLiveFixture('plain').files)
    const file = tempFile()
    const errors: Error[] = []
    let calls = 0
    const reader = new DurableReader(file, {
      onRows: () => {
        calls += 1
        if (calls === 1) throw new Error('consumer bug')
      },
      onError: error => errors.push(error),
    }, { fastPollMs: 10_000 })
    writeFileSync(file, recorded!.slice(0, 3).map(line).join('') + 'garbage\n')
    await reader.ring()
    appendFileSync(file, recorded!.slice(3).map(line).join(''))
    await reader.ring()
    await reader.stop()
    expect(errors.map(error => error.message)).toEqual([expect.stringContaining('line 3'), 'consumer bug'])
    expect(calls).toBe(2)
  })

  it('the poll timer picks up appends with no doorbell at all', async () => {
    const [recorded] = Object.values(loadLiveFixture('plain').files)
    const file = tempFile()
    const rows: string[] = []
    const reader = new DurableReader(file, { onRows: batch => rows.push(...batch.map(row => row.id)) }, { fastPollMs: 20 })
    reader.start()
    writeFileSync(file, recorded!.map(line).join(''))
    const deadline = Date.now() + 2000
    while (rows.length < recorded!.length - 1 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))
    await reader.stop()
    expect(rows).toEqual(recorded!.slice(1).map(row => row.id))
  })
})
