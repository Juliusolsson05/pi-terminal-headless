import { describe, expect, it } from 'vitest'

import { listLiveFixtures, loadDurableFixtureText, loadLiveFixture, toJsonl } from '../testing/fixtures.js'
import { isMessageRow, messageRole, parseSessionText, SessionFileError } from './SessionFile.js'

describe('parseSessionText over recorded v3 files', () => {
  it('returns the header separately and every other row with its physical line, id and parentId as written', () => {
    for (const name of listLiveFixtures()) {
      const fixture = loadLiveFixture(name)
      for (const rows of Object.values(fixture.files)) {
        const parsed = parseSessionText(toJsonl(rows))
        expect(parsed.errors).toEqual([])
        expect(parsed.header?.id).toBe(rows[0]!.id)
        expect(parsed.rows.map(row => [row.line, row.id, row.parentId])).toEqual(rows.slice(1).map((row, index) => [index + 1, row.id, row.parentId]))
      }
    }
  })
})

describe('version tolerance (Pi migrates old files in place only when it loads them)', () => {
  it('v1: chains the linear rows exactly as Pi migrateV1ToV2 would, with stable line-based ids', () => {
    const { header, rows, errors } = parseSessionText(loadDurableFixtureText('v1-linear.jsonl'))
    expect(errors).toEqual([])
    expect(header?.version).toBeUndefined()
    expect(rows.map(row => row.id)).toEqual(rows.map(row => `v1-${row.line}`))
    rows.forEach((row, index) => expect(row.parentId).toBe(index === 0 ? null : rows[index - 1]!.id))
    // Row kinds survive: an aborted assistant, a model change mid-file, a tool round trip.
    expect(rows.map(row => messageRole(row) ?? row.type)).toEqual([
      'user', 'assistant', 'model_change', 'user', 'assistant', 'toolResult', 'thinking_level_change', 'assistant',
    ])
  })

  it('v2: renames the hookMessage role to custom, as v3 did', () => {
    const { rows } = parseSessionText(loadDurableFixtureText('v2-hook-message.jsonl'))
    const hook = rows.find(row => row.id === 'c3d4e5f6')!
    expect(isMessageRow(hook) && hook.message.role).toBe('custom')
    expect(hook.parentId).toBe('b2c3d4e5')
  })
})

describe('what is and is not committed', () => {
  const header = '{"type":"session","version":3,"id":"s","timestamp":"t","cwd":"/c"}'
  const row = (id: string, parentId: string | null, type = 'message') => JSON.stringify({ type, id, parentId, timestamp: 't', message: { role: 'user', content: 'x' } })

  it('never commits an unterminated last line (pi may still be writing it)', () => {
    const text = `${header}\n${row('a', null)}\n${row('b', 'a').slice(0, 20)}`
    expect(parseSessionText(text).rows.map(r => r.id)).toEqual(['a'])
  })

  it('reports a corrupt line and keeps reading the rest (one bad line must not hide a conversation)', () => {
    const text = `${header}\n${row('a', null)}\nnot json\n[1,2]\n${row('b', 'a')}\n`
    const parsed = parseSessionText(text)
    expect(parsed.rows.map(r => r.id)).toEqual(['a', 'b'])
    expect(parsed.errors.map(e => [e.code, e.line])).toEqual([['invalid_json', 2], ['not_an_object', 3]])
    expect(parsed.errors[0]).toBeInstanceOf(SessionFileError)
  })

  it('passes an entry type it does not know through untouched (Pi adds types in minors)', () => {
    const future = JSON.stringify({ type: 'hologram', id: 'z', parentId: 'a', timestamp: 't', payload: { deep: [1] } })
    const parsed = parseSessionText(`${header}\n${row('a', null)}\n${future}\n`)
    expect(parsed.rows[1]).toMatchObject({ type: 'hologram', id: 'z', parentId: 'a', payload: { deep: [1] } })
  })

  it('refuses rows before any header: that is not a Pi session file', () => {
    const parsed = parseSessionText(`${row('a', null)}\n`)
    expect(parsed.header).toBeUndefined()
    expect(parsed.rows).toEqual([])
    expect(parsed.errors[0]?.code).toBe('missing_header')
  })
})
