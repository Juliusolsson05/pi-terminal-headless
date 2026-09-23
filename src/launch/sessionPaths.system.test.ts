import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { loadLiveFixture, toJsonl } from '../testing/fixtures.js'
import { encodeCwdForSessionDir, listAllPiSessionFiles, resolvePiAgentDir, resolvePiSessionDir, resolvePiSessionFile, resolvePiSessionsRoot, sessionIdFromFileName } from './sessionPaths.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function header(id: string, cwd: string): string {
  return JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-09-22T00:00:00.000Z', cwd }) + '\n'
}

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
    // A header row, because Pi identifies a session by it (findById): an empty
    // file named after an id is not a session Pi would resume.
    writeFileSync(join(dir, name), header('709ab74b-2d9d-434a-9298-d7dc22c53d42', '/w/p'))
    expect(sessionIdFromFileName(name)).toBe('709ab74b-2d9d-434a-9298-d7dc22c53d42')
    expect(await resolvePiSessionFile({ env: {}, homeDirectory: h, cwd: '/w/p', sessionId: '709ab74b-2d9d-434a-9298-d7dc22c53d42' })).toBe(join(dir, name))
    expect(await resolvePiSessionFile({ env: {}, homeDirectory: h, cwd: '/w/p', sessionId: 'other' })).toBeNull()
    expect(await resolvePiSessionFile({ env: {}, homeDirectory: h, cwd: '/nowhere', sessionId: 'x' })).toBeNull()
  })

  it('a symlinked cwd resolves to the directory pi wrote (pi encodes process.cwd(), the real path)', async () => {
    const h = home()
    const real = join(h, 'real-project')
    mkdirSync(real)
    const link = join(h, 'linked-project')
    symlinkSync(real, link)
    expect(await resolvePiSessionDir({ env: {}, homeDirectory: h, cwd: link }))
      .toBe(join(h, '.pi', 'agent', 'sessions', encodeCwdForSessionDir(realpathSync(real))))
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

describe('relative configured paths resolve against the pi process cwd (Astra finding 5)', () => {
  // Pi keeps these relative and readdir()s them from ITS process.cwd() — the
  // pane's project — never from Agent Code's own cwd.
  it('PI_CODING_AGENT_SESSION_DIR, the sessionDir setting and --session-dir', async () => {
    const h = home()
    const project = realpathSync(home())
    expect(relative(process.cwd(), project)).not.toBe('')
    expect(await resolvePiSessionDir({ env: { PI_CODING_AGENT_SESSION_DIR: 'sessions' }, homeDirectory: h, cwd: project })).toBe(join(project, 'sessions'))
    expect(await resolvePiSessionDir({ env: {}, homeDirectory: h, cwd: project, sessionDirOverride: './flag' })).toBe(join(project, 'flag'))
    mkdirSync(join(h, '.pi', 'agent'), { recursive: true })
    writeFileSync(join(h, '.pi', 'agent', 'settings.json'), JSON.stringify({ sessionDir: 'from-settings' }))
    expect(await resolvePiSessionDir({ env: {}, homeDirectory: h, cwd: project })).toBe(join(project, 'from-settings'))
  })

  it('a relative PI_CODING_AGENT_DIR, and file:// URLs like Pi normalizePath', async () => {
    const h = home()
    const project = realpathSync(home())
    expect(await resolvePiSessionDir({ env: { PI_CODING_AGENT_DIR: '.pi-agent' }, homeDirectory: h, cwd: project }))
      .toBe(join(project, '.pi-agent', 'sessions', encodeCwdForSessionDir(project)))
    expect(await resolvePiSessionDir({ env: { PI_CODING_AGENT_SESSION_DIR: pathToFileURL(join(h, 'url-dir')).href }, homeDirectory: h, cwd: project })).toBe(join(h, 'url-dir'))
  })

  it('finds the session pi wrote under a relative dir from the pane cwd, and the catalog does not guess a root', async () => {
    const h = home()
    const project = realpathSync(home())
    mkdirSync(join(project, 'sessions'))
    writeFileSync(join(project, 'sessions', '2026-01-01T00-00-00-000Z_rel.jsonl'), header('rel', project))
    const env = { PI_CODING_AGENT_SESSION_DIR: 'sessions' }
    expect(await resolvePiSessionFile({ env, homeDirectory: h, cwd: project, sessionId: 'rel' })).toBe(join(project, 'sessions', '2026-01-01T00-00-00-000Z_rel.jsonl'))
    expect(await listAllPiSessionFiles({ env, homeDirectory: h })).toEqual([])
  })
})

describe('session lookup by header, like Pi SessionManager.findById (Astra finding 6)', () => {
  it('finds a recorded session renamed to conversation.jsonl, as pi --session-id / /resume does', async () => {
    const h = home()
    const fixture = loadLiveFixture('tool')
    const [path] = Object.keys(fixture.files)
    const rows = fixture.files[path!]!
    const id = String(rows[0]!.id)
    const cwd = '/sandbox/project'
    const dir = await resolvePiSessionDir({ env: {}, homeDirectory: h, cwd })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'conversation.jsonl'), toJsonl(rows))
    expect(await resolvePiSessionFile({ env: {}, homeDirectory: h, cwd, sessionId: id })).toBe(join(dir, 'conversation.jsonl'))
  })

  it('a file NAMED after the id whose header says otherwise is not that session', async () => {
    const h = home()
    const dir = await resolvePiSessionDir({ env: {}, homeDirectory: h, cwd: '/w/p' })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '2026-01-01T00-00-00-000Z_wanted.jsonl'), header('someone-else', '/w/p'))
    writeFileSync(join(dir, 'blank-then-header.jsonl'), '\nnot json\n' + header('wanted', '/w/p'))
    writeFileSync(join(dir, 'row-first.jsonl'), JSON.stringify({ type: 'message', id: 'wanted' }) + '\n' + header('wanted', '/w/p'))
    // Pi skips blank and malformed lines before the header, and a non-header
    // first row means "not a session".
    expect(await resolvePiSessionFile({ env: {}, homeDirectory: h, cwd: '/w/p', sessionId: 'wanted' })).toBe(join(dir, 'blank-then-header.jsonl'))
  })

  it('in a custom flat dir, only a header whose cwd is this project counts', async () => {
    const h = home()
    const flat = join(h, 'flat')
    mkdirSync(flat)
    writeFileSync(join(flat, '2026-01-01T00-00-00-000Z_same.jsonl'), header('same', '/other/project'))
    const env = { PI_CODING_AGENT_SESSION_DIR: flat }
    expect(await resolvePiSessionFile({ env, homeDirectory: h, cwd: '/w/p', sessionId: 'same' })).toBeNull()
    writeFileSync(join(flat, 'copy.jsonl'), header('same', '/w/p'))
    expect(await resolvePiSessionFile({ env, homeDirectory: h, cwd: '/w/p', sessionId: 'same' })).toBe(join(flat, 'copy.jsonl'))
  })
})
