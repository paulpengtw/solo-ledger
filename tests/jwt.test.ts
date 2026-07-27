import { describe, it, expect, beforeAll } from 'vitest'
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JWTVerifyGetKey } from 'jose'
import { verifyAccessJwt } from '../functions/lib/jwt'

const AUD = 'test-aud-tag'
let jwks: JWTVerifyGetKey
let privateKey: CryptoKey

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  privateKey = pair.privateKey as CryptoKey
  const jwk = await exportJWK(pair.publicKey)
  jwks = createLocalJWKSet({ keys: [{ ...jwk, alg: 'RS256', kid: 'k1' }] })
})

function sign(claims: { aud?: string; expOffsetSec?: number }): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setAudience(claims.aud ?? AUD)
    .setExpirationTime(now + (claims.expOffsetSec ?? 3600))
    .setIssuedAt(now)
    .sign(privateKey)
}

describe('verifyAccessJwt', () => {
  it('accepts a valid token and returns its exp', async () => {
    const token = await sign({})
    const r = await verifyAccessJwt(`CF_Authorization=${token}`, AUD, jwks)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.exp).toBeGreaterThan(Date.now() / 1000)
  })
  it('rejects an expired token', async () => {
    const token = await sign({ expOffsetSec: -60 })
    expect(await verifyAccessJwt(`CF_Authorization=${token}`, AUD, jwks)).toEqual({ ok: false })
  })
  it('rejects a wrong audience', async () => {
    const token = await sign({ aud: 'someone-else' })
    expect(await verifyAccessJwt(`CF_Authorization=${token}`, AUD, jwks)).toEqual({ ok: false })
  })
  it('rejects a missing cookie', async () => {
    expect(await verifyAccessJwt(null, AUD, jwks)).toEqual({ ok: false })
    expect(await verifyAccessJwt('other=1', AUD, jwks)).toEqual({ ok: false })
  })
  it('rejects garbage tokens', async () => {
    expect(await verifyAccessJwt('CF_Authorization=not.a.jwt', AUD, jwks)).toEqual({ ok: false })
  })
})
