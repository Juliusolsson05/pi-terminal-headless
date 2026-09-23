import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { BRIDGE_SOCKET_ENV, BRIDGE_TOKEN_ENV } from '../bridge/protocol.js'
import { preparePiTerminalLaunch } from './prepareLaunch.js'
import { resolvePiSessionDir } from './sessionPaths.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-launch-'))
  dirs.push(dir)
  return dir
}

describe('preparePiTerminalLaunch', () => {
  it('owns the identity flags, keeps the token out of argv, and gives a short private socket path', async () => {
    const h = home()
    const launch = await preparePiTerminalLaunch({ binary: 'pi', cwd: '/w/p', env: { A: '1' }, sessionId: 'id-1', bridgeScriptPath: '/b/bridge.ts', homeDirectory: h, extraArgs: ['--model', 'x'] })
    try {
      expect(launch.args).toEqual(['--session-id', 'id-1', '-e', '/b/bridge.ts', '--model', 'x'])
      expect(launch.env).toMatchObject({ A: '1', [BRIDGE_SOCKET_ENV]: launch.socketPath, [BRIDGE_TOKEN_ENV]: launch.token })
      expect(launch.args.join(' ')).not.toContain(launch.token)
      // macOS sun_path is 104 bytes; an overlong path once crashed pi (Stage 0).
      expect(Buffer.byteLength(launch.socketPath)).toBeLessThan(104)
      const dir = join(launch.socketPath, '..')
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      expect(launch.existingFile).toBeNull()
      expect(launch.sessionDir).toBe(await resolvePiSessionDir({ env: { A: '1' }, homeDirectory: h, cwd: '/w/p' }))
    } finally {
      await launch.dispose()
      await launch.dispose() // idempotent
    }
    expect(existsSync(join(launch.socketPath, '..'))).toBe(false)
  })

  it('finds the existing file when resuming', async () => {
    const h = home()
    const dir = await resolvePiSessionDir({ env: {}, homeDirectory: h, cwd: '/w/p' })
    mkdirSync(dir, { recursive: true })
    // A header row: Pi (and so the lookup) identifies a session by it, not by the name.
    writeFileSync(join(dir, '2026-01-01T00-00-00-000Z_id-2.jsonl'), JSON.stringify({ type: 'session', version: 3, id: 'id-2', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/w/p' }) + '\n')
    const launch = await preparePiTerminalLaunch({ binary: 'pi', cwd: '/w/p', env: {}, sessionId: 'id-2', bridgeScriptPath: '/b', homeDirectory: h })
    await launch.dispose()
    expect(launch.existingFile).toBe(join(dir, '2026-01-01T00-00-00-000Z_id-2.jsonl'))
  })

  it('refuses extra args that would take over the session it owns', async () => {
    for (const flag of ['--session', '--session-id', '--continue', '--resume', '--fork', '--no-session', '--session-dir=/x', '--mode', '-p']) {
      await expect(preparePiTerminalLaunch({ binary: 'pi', cwd: '/w', env: {}, sessionId: 'x', bridgeScriptPath: '/b', homeDirectory: home(), extraArgs: [flag] })).rejects.toThrow(/owned by the launch/)
    }
  })
})
