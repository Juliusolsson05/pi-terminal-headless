import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadLiveFixture } from '../testing/fixtures.js'
import { encodeCwdForSessionDir, listAllPiSessionFiles, resolvePiAgentDir, resolvePiSessionDir, resolvePiSessionFile, resolvePiSessionsRoot, sessionIdFromFileName } from './sessionPaths.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-home-'))
  dirs.push(dir)
  return dir
}

describe('session directory resolution (mirrors the pinned Pi release)', () => {
  it('encodes the cwd the way Pi named the recorded session directories', () => {
    // The recordings ran with cwd /private/var/.../acpi-probe-<scenario>-<hex>/project,
    // normalized to "sandbox"; the suffix shape is what Pi produced.
    const [file] = Object.keys(loadLiveFixture('plain').files)
    expect(file).toMatch(/\/sessions\/--sandbox-project--\//)
    expect(encodeCwdForSessionDir('/Users/a/my proj')).toBe('--Users-a-my proj--')
    expect(encodeCwdForSessionDir('C:\\work\\x')).toContain('C--work-x')
  })

  it('default: <agentDir>/sessions/--<cwd>--, with PI_CODING_AGENT_DIR (tilde-expanded) as the agent dir', async () => {
    const h = home()
    expect(resolvePiAgentDir({ env: {}, homeDirectory: h })).toBe(join(h, '.pi', 'agent'))
    expect(resolvePiAgentDir({ env: { PI_CODING_AGENT_DIR: '~/alt' }, homeDirectory: h })).toBe(join(h, 'alt'))
    expect(await resolvePiSessionDir({ env: {}, homeDirectory: h, cwd: '/w/p' })).toBe(join(h, '.pi', 'agent', 'sessions', '--w-p--'))
  })

  it('precedence: --session-dir > PI_CODING_AGENT_SESSION_DIR > settings sessionDir > default; custom dirs are flat', async () => {
    const h = home()
    mkdirSync(join(h, '.pi', 'agent'), { recursive: true })
    writeFileSync(join(h, '.pi', 'agent', 'settings.json'), JSON.stringify({ sessionDir: '~/from-settings' }))
    expect(await resolvePiSessionDir({ env: {}, homeDirectory: h, cwd: '/w/p' })).toBe(join(h, 'from-settings'))
    expect(await resolvePiSessionDir({ env: { PI_CODING_AGENT_SESSION_DIR: '/env-dir' }, homeDirectory: h, cwd: '/w/p' })).toBe('/env-dir')
    expect(await resolvePiSessionDir({ env: { PI_CODING_AGENT_SESSION_DIR: '/env-dir' }, homeDirectory: h, cwd: '/w/p', sessionDirOverride: '/flag' })).toBe('/flag')
  })

  it('finds a session file by id from its <ts>_<id>.jsonl name, and returns null when absent', async () => {
    const h = home()
    const dir = await resolvePiSessionDir({ env: {}, homeDirectory: h, cwd: '/w/p' })
    mkdirSync(dir, { recursive: true })
    const name = '2026-09-22T23-57-42-771Z_709ab74b-2d9d-434a-9298-d7dc22c53d42.jsonl'
    writeFileSync(join(dir, name), '')
    expect(sessionIdFromFileName(name)).toBe('709ab74b-2d9d-434a-9298-d7dc22c53d42')
    expect(await resolvePiSessionFile({ env: {}, homeDirectory: h, cwd: '/w/p', sessionId: '709ab74b-2d9d-434a-9298-d7dc22c53d42' })).toBe(join(dir, name))
    expect(await resolvePiSessionFile({ env: {}, homeDirectory: h, cwd: '/w/p', sessionId: 'other' })).toBeNull()
    expect(await resolvePiSessionFile({ env: {}, homeDirectory: h, cwd: '/nowhere', sessionId: 'x' })).toBeNull()
  })

  it('lists every session across per-cwd directories by default, or a flat custom dir', async () => {
    const h = home()
    const perCwd = join(h, '.pi', 'agent', 'sessions')
    mkdirSync(join(perCwd, '--a--'), { recursive: true })
    mkdirSync(join(perCwd, '--b--'), { recursive: true })
    writeFileSync(join(perCwd, '--a--', '2026-01-01T00-00-00-000Z_one.jsonl'), '')
    writeFileSync(join(perCwd, '--b--', '2026-01-02T00-00-00-000Z_two.jsonl'), '')
    writeFileSync(join(perCwd, '--b--', 'notes.txt'), '')
    expect(await resolvePiSessionsRoot({ env: {}, homeDirectory: h })).toEqual({ root: perCwd, layout: 'per-cwd' })
    expect((await listAllPiSessionFiles({ env: {}, homeDirectory: h })).map(f => f.split('/').at(-1))).toEqual([
      '2026-01-01T00-00-00-000Z_one.jsonl', '2026-01-02T00-00-00-000Z_two.jsonl',
    ])
    const flat = join(h, 'flat')
    mkdirSync(flat)
    writeFileSync(join(flat, '2026-01-03T00-00-00-000Z_three.jsonl'), '')
    expect(await listAllPiSessionFiles({ env: { PI_CODING_AGENT_SESSION_DIR: flat }, homeDirectory: h })).toEqual([join(flat, '2026-01-03T00-00-00-000Z_three.jsonl')])
  })
})
