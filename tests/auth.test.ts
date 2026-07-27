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

  it('schedules exactly one check when the session expires a month out (32-bit setTimeout ceiling)', async () => {
    const delays: number[] = []
    const originalSetTimeout = globalThis.setTimeout

    try {
      globalThis.setTimeout = ((fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
        if (typeof delay === 'number') {
          delays.push(delay)
          const clamped = delay >= 2 ** 31 ? 1 : delay
          return originalSetTimeout(fn, clamped, ...args)
        }
        return originalSetTimeout(fn, delay, ...args)
      }) as unknown as typeof setTimeout

      const nowSeconds = 1_753_600_000
      const check = vi.fn(async () => ({
        ok: true as const,
        exp: nowSeconds + 30 * 24 * 3600,
      }))
      const guard = startSessionGuard({ check, onExpired: vi.fn(), now: () => nowSeconds })

      await vi.advanceTimersByTimeAsync(0)

      await vi.advanceTimersByTimeAsync(10_000)
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.advanceTimersByTimeAsync(10_000)

      expect(check).toHaveBeenCalledTimes(1)
      expect(delays.length).toBeGreaterThan(0)
      expect(delays.every(d => d < 2_147_483_647)).toBe(true)

      guard.stop()
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('does not self-repeat when exp is missing, non-finite, or already past', async () => {
    const nowSeconds = 1_753_600_000
    for (const value of [undefined as unknown as number, Number.NaN, nowSeconds - 100]) {
      const check = vi.fn(async () => ({ ok: true as const, exp: value }))
      const onExpired = vi.fn()
      const guard = startSessionGuard({ check, onExpired, now: () => nowSeconds })

      await vi.advanceTimersByTimeAsync(0)   // startup check = 1 call
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.advanceTimersByTimeAsync(10_000)

      expect(check, `exp=${String(value)}`).toHaveBeenCalledTimes(1)
      expect(onExpired, `exp=${String(value)}`).not.toHaveBeenCalled()

      guard.stop()
    }
  })
})
