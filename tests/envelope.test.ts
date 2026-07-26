import { describe, it, expect } from 'vitest'
import { buildEnvelope } from '../functions/lib/envelope'
import fixture from './fixtures/create-envelope.json'

describe('buildEnvelope', () => {
  // Known-good vector from expense_api.py _selftest — independent source of truth.
  it('matches the python client selftest vector byte-for-byte', async () => {
    const env = await buildEnvelope('test-secret', { action: 'health' }, 1700000000, 'n')
    expect(env.sig).toBe('1y9SbkCDwSoRyWDmZqoaOa5ppMAApiAHzWU2ODwQhqo')
    expect(env.ts).toBe(1700000000)
    expect(env.nonce).toBe('n')
  })

  it('matches the python-generated create fixture byte-for-byte (CJK payload)', async () => {
    const env = await buildEnvelope(fixture.secret, fixture.input, fixture.envelope.ts, fixture.envelope.nonce)
    expect(env.payload).toBe(fixture.envelope.payload)
    expect(env.sig).toBe(fixture.envelope.sig)
  })

  it('produces unpadded base64url', async () => {
    const env = await buildEnvelope('s', { action: 'health' }, 1, 'n')
    expect(env.payload).not.toMatch(/[=+/]/)
    expect(env.sig).not.toMatch(/[=+/]/)
  })
})
