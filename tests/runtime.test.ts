import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildEnvelope } from '../functions/lib/envelope'
import { APP_VERSION, CONTRACT_VERSION } from '../src/generated/version'
import { loadGasFunctionsWithFakeGas } from './helpers/gas'

const root = fileURLToPath(new URL('..', import.meta.url))

async function post(harness: ReturnType<typeof loadGasFunctionsWithFakeGas>, payload: Record<string, unknown>, nonce: string) {
  const envelope = await buildEnvelope('test-secret', payload, Math.floor(Date.now() / 1000), nonce)
  return JSON.parse(harness.doPost({ postData: { contents: JSON.stringify(envelope) } }).getContent()) as Record<string, unknown>
}

describe('integration runtime', () => {
  it('emits the verified contract and source revision in both runtime artifacts', () => {
    const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    const gasVersion = readFileSync(fileURLToPath(new URL('../apps-script/Version.gs', import.meta.url)), 'utf8')
    expect(APP_VERSION).toBe(source)
    expect(gasVersion).toContain(`var APP_VERSION = '${source}';`)
    expect(gasVersion).toContain(`var CONTRACT_VERSION = '${CONTRACT_VERSION}';`)
  })

  it('keeps identity readable while closed and gates financial actions by maintenance and version', async () => {
    const harness = loadGasFunctionsWithFakeGas()
    harness.setScriptProperty('INTEGRATION_OPEN', '')
    harness.clearEvents()
    expect(await post(harness, { action: 'integrationState' }, 'state-1')).toEqual({
      identity: { contractVersion: CONTRACT_VERSION, appVersion: APP_VERSION },
      maintenance: { kind: 'maintenance', message: '系統更新中' },
    })
    expect(harness.events).toEqual([])
    expect(await post(harness, { action: 'health', contractVersion: CONTRACT_VERSION }, 'health-closed'))
      .toEqual({ ok: false, error: '系統更新中' })
    harness.setScriptProperty('INTEGRATION_OPEN', 'true')
    expect(await post(harness, { action: 'health' }, 'health-missing'))
      .toEqual({ ok: false, error: '版本已更新，請重新整理頁面' })
    expect(await post(harness, { action: 'health', contractVersion: 'old' }, 'health-old'))
      .toEqual({ ok: false, error: '版本已更新，請重新整理頁面' })
    expect(await post(harness, { action: 'bogus', contractVersion: CONTRACT_VERSION }, 'current'))
      .toEqual({ ok: false, error: 'unsupported action: bogus' })
  })

  it('rejects an older maintenance command after a newer choice', async () => {
    const harness = loadGasFunctionsWithFakeGas()
    const now = Date.now()
    const old = { action: 'setMaintenance', open: false, commandTs: now - 1,
      commandNonce: 'command-old', contractVersion: CONTRACT_VERSION }
    const latest = { ...old, open: true, commandTs: now, commandNonce: 'command-new' }
    expect((await post(harness, old, 'command-old')).maintenance).toEqual({ kind: 'maintenance', message: '系統更新中' })
    expect((await post(harness, latest, 'command-new')).maintenance).toEqual({ kind: 'open' })
    expect(await post(harness, old, 'command-old')).toEqual({ ok: false, error: 'stale maintenance command' })
    expect(harness.peekScriptProperty('INTEGRATION_OPEN')).toBe('true')
    expect((await post(harness, latest, 'command-new')).maintenance).toEqual({ kind: 'open' })
  })
})
