import { beforeAll, describe, expect, it, vi } from 'vitest'
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose'
import { handleAction, type Env } from '../functions/lib/handler'
import { handleIdentity } from '../functions/lib/identity'
import { APP_VERSION, CONTRACT_VERSION } from '../src/generated/version'

const NOW = 1_700_000_000
const env: Env = {
  EXPENSE_API_URL: 'https://script.example/exec',
  EXPENSE_API_SECRET: 'test-secret',
  CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
  CF_ACCESS_AUD: 'aud-tag',
}
const differentGasSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
let jwks: JWTVerifyGetKey
let humanToken: string
let serviceToken: string

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  const jwk = await exportJWK(pair.publicKey)
  jwks = createLocalJWKSet({ keys: [{ ...jwk, alg: 'RS256', kid: 'k1' }] })
  const sign = (claims: Record<string, unknown>) => new SignJWT({ type: 'app', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(`https://${env.CF_ACCESS_TEAM_DOMAIN}`)
    .setAudience(env.CF_ACCESS_AUD)
    .setIssuedAt(NOW)
    .setExpirationTime(NOW + 3600)
    .sign(pair.privateKey as CryptoKey)
  humanToken = await sign({ sub: 'user-id', email: 'azhe@example.com' })
  serviceToken = await sign({ sub: '', common_name: 'dashboard-client' })
})

const gasState = (maintenance: object = { kind: 'open' }) => ({
  identity: { contractVersion: CONTRACT_VERSION, appVersion: differentGasSha }, maintenance,
})
const jsonFetch = (body: unknown): typeof fetch =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
const deps = (fetchFn: typeof fetch) => ({ jwks, fetchFn, now: () => NOW })

describe('Pages identity', () => {
  it('accepts a signed service assertion and reports both actual component revisions', async () => {
    const fetchFn = jsonFetch(gasState())
    const request = new Request('https://ledger.example/api/identity', {
      headers: { 'cf-access-jwt-assertion': serviceToken },
    })
    const response = await handleIdentity(request, env, deps(fetchFn))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      identity: { contractVersion: CONTRACT_VERSION, appVersion: APP_VERSION },
      backendIdentity: { contractVersion: CONTRACT_VERSION, appVersion: differentGasSha },
      maintenance: { kind: 'open' },
    })
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it('allows a human cookie to read backend maintenance and reports an unreachable backend unavailable', async () => {
    const request = new Request('https://ledger.example/api/identity', {
      headers: { cookie: `CF_Authorization=${humanToken}` },
    })
    const paused = await handleIdentity(request, env, deps(jsonFetch(gasState({ kind: 'maintenance', message: '系統更新中' }))))
    expect(paused.status).toBe(200)
    expect((await paused.json() as { maintenance: unknown }).maintenance)
      .toEqual({ kind: 'maintenance', message: '系統更新中' })
    const failedFetch = vi.fn(async () => { throw new Error('network down') }) as unknown as typeof fetch
    const unavailable = await handleIdentity(request, env, deps(failedFetch))
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toEqual({ ok: false, error: '服務暫時無法使用' })
  })

  it('rejects a service token carried as a financial cookie before calling GAS', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('must not fetch') }) as unknown as typeof fetch
    const request = new Request('https://ledger.example/api/health', {
      method: 'POST',
      headers: { cookie: `CF_Authorization=${serviceToken}`, 'x-contract-version': CONTRACT_VERSION },
    })
    const response = await handleAction('health', request, env, deps(fetchFn))
    expect(response.status).toBe(401)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('rejects a wrong contract pin even when GAS reports open', async () => {
    const request = new Request('https://ledger.example/api/identity', {
      headers: { 'cf-access-jwt-assertion': serviceToken },
    })
    const response = await handleIdentity(request, env, deps(jsonFetch({
      identity: { contractVersion: 'old', appVersion: differentGasSha },
      maintenance: { kind: 'open' },
    })))
    expect(response.status).toBe(503)
  })
})
