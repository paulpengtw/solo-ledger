import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startSessionGuard } from '../src/auth'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('startSessionGuard', () => {
  it('checks immediately and surfaces re-auth when the session is expired', async () => {
    const check = vi.fn(async () => ({ ok: false as const }))
    const onExpired = vi.fn()

    startSessionGuard({ check, onExpired })
    await vi.advanceTimersByTimeAsync(0)

    expect(check).toHaveBeenCalledTimes(1)
    expect(onExpired).toHaveBeenCalledTimes(1)
  })

  it('runs another auth-check when the app becomes visible', async () => {
    const check = vi.fn(async () => ({
      ok: true as const,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }))
    const guard = startSessionGuard({ check, onExpired: vi.fn() })
    await vi.advanceTimersByTimeAsync(0)
    const callsBeforeVisibility = check.mock.calls.length

    guard.onVisible()
    await vi.advanceTimersByTimeAsync(0)

    expect(check).toHaveBeenCalledTimes(callsBeforeVisibility + 1)
    guard.stop()
  })
})
