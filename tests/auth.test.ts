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
    let nowSeconds = 1_753_600_000
    const check = vi.fn(async () => ({
      ok: true as const,
      exp: nowSeconds + 3600,
    }))
    const guard = startSessionGuard({ check, onExpired: vi.fn(), now: () => nowSeconds })
    await vi.advanceTimersByTimeAsync(0)
    const callsBeforeVisibility = check.mock.calls.length

    // Advance past the 5-minute minimum check interval before calling onVisible
    await vi.advanceTimersByTimeAsync(300_000)
    nowSeconds += 300_000 / 1000

    guard.onVisible()
    await vi.advanceTimersByTimeAsync(0)

    expect(check).toHaveBeenCalledTimes(callsBeforeVisibility + 1)
    guard.stop()
  })

  it('never schedules a timer, even for a month-out session (32-bit setTimeout ceiling)', async () => {
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

      let nowSeconds = 1_753_600_000
      const onExpired = vi.fn()
      const check = vi.fn(async () => ({
        ok: true as const,
        exp: nowSeconds + 30 * 24 * 3600,
      }))
      const guard = startSessionGuard({ check, onExpired, now: () => nowSeconds })

      await vi.advanceTimersByTimeAsync(0)   // startup check = 1 call

      // Advance 10 minutes in 60 s steps — deliberately exceeds the old 60 s heartbeat period
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(60_000)
        nowSeconds += 60
      }

      expect(check).toHaveBeenCalledTimes(1)
      expect(delays).toHaveLength(0)
      expect(onExpired).not.toHaveBeenCalled()

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

  it('stays quiet after startup while the session is live (no heartbeat)', async () => {
    const nowSeconds = 1_753_600_000
    const check = vi.fn(async () => ({
      ok: true as const,
      exp: nowSeconds + 3600,
    }))
    const onExpired = vi.fn()
    const guard = startSessionGuard({ check, onExpired, now: () => nowSeconds })

    await vi.advanceTimersByTimeAsync(0)    // startup check = 1 call

    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(60_000)
    }

    expect(check).toHaveBeenCalledTimes(1)
    expect(onExpired).not.toHaveBeenCalled()
    guard.stop()
  })

  it('coalesces onVisible bursts through the minimum check interval', async () => {
    let nowSeconds = 1_753_600_000
    const exp = nowSeconds + 30 * 24 * 3600
    const check = vi.fn(async () => ({ ok: true as const, exp }))
    const onExpired = vi.fn()
    const guard = startSessionGuard({ check, onExpired, now: () => nowSeconds })

    await vi.advanceTimersByTimeAsync(0)  // startup check = 1 call
    expect(check).toHaveBeenCalledTimes(1)

    // Fire five onVisible() calls — all within the 5-min window of the startup check
    guard.onVisible()
    guard.onVisible()
    guard.onVisible()
    guard.onVisible()
    guard.onVisible()
    await vi.advanceTimersByTimeAsync(0)

    // All five should be coalesced — still exactly 1 check
    expect(check).toHaveBeenCalledTimes(1)

    // Advance 5 minutes past the startup check
    await vi.advanceTimersByTimeAsync(300_000)
    nowSeconds += 300_000 / 1000

    // Now an onVisible() trigger should be allowed through
    guard.onVisible()
    await vi.advanceTimersByTimeAsync(0)

    expect(check).toHaveBeenCalledTimes(2)
    guard.stop()
  })

  it('stays under 289 checks across a day of backgrounding and foregrounding', async () => {
    let nowSeconds = 1_753_600_000
    const exp = nowSeconds + 30 * 24 * 3600
    const checkTimes: number[] = []
    const onExpired = vi.fn()
    const check = vi.fn(async () => {
      checkTimes.push(nowSeconds)
      return { ok: true as const, exp }
    })
    const guard = startSessionGuard({ check, onExpired, now: () => nowSeconds })

    await vi.advanceTimersByTimeAsync(0)  // startup check

    // Simulate 24 hours: 960 iterations × 90 s = 86,400 s
    for (let i = 0; i < 960; i++) {
      await vi.advanceTimersByTimeAsync(90_000)
      nowSeconds += 90_000 / 1000
      guard.onVisible()
      guard.onVisible()
    }

    // (a) 1 startup + at most 1 per 5-min window = 1 + 288 = 289
    expect(check.mock.calls.length).toBeLessThanOrEqual(289)

    // (b) every consecutive pair of recorded check times is >= 300 s apart
    for (let i = 1; i < checkTimes.length; i++) {
      expect(checkTimes[i]! - checkTimes[i - 1]!).toBeGreaterThanOrEqual(300)
    }

    // (c) onExpired must never fire (session is always live)
    expect(onExpired).not.toHaveBeenCalled()

    guard.stop()
  })

  it('surfaces re-auth promptly when the session goes invalid', async () => {
    let nowSeconds = 1_753_600_000
    const check = vi.fn(async (): Promise<{ ok: true; exp: number } | { ok: false }> => ({
      ok: true,
      exp: nowSeconds + 30 * 24 * 3600,
    }))
    const onExpired = vi.fn()

    const guard = startSessionGuard({ check, onExpired, now: () => nowSeconds })
    await vi.advanceTimersByTimeAsync(0)

    expect(check).toHaveBeenCalledTimes(1)
    expect(onExpired).not.toHaveBeenCalled()

    // Advance 301 s — past the 5-minute minimum check interval
    await vi.advanceTimersByTimeAsync(301_000)
    nowSeconds += 301

    // Flip the mock: session has gone invalid
    check.mockResolvedValue({ ok: false })

    guard.onVisible()
    await vi.advanceTimersByTimeAsync(0)

    expect(check).toHaveBeenCalledTimes(2)
    expect(onExpired).toHaveBeenCalledTimes(1)

    guard.stop()
  })

  it('stop() prevents any further checks', async () => {
    let nowSeconds = 1_753_600_000
    const check = vi.fn(async () => ({
      ok: true as const,
      exp: nowSeconds + 30 * 24 * 3600,
    }))
    const onExpired = vi.fn()
    const guard = startSessionGuard({ check, onExpired, now: () => nowSeconds })

    await vi.advanceTimersByTimeAsync(0)
    expect(check).toHaveBeenCalledTimes(1)

    guard.stop()

    // Simulate 24 hours: 60 iterations × 1,440 s = 86,400 s
    for (let i = 0; i < 60; i++) {
      await vi.advanceTimersByTimeAsync(1_440_000)
      nowSeconds += 1440
      guard.onVisible()
      guard.onVisible()
    }

    expect(check).toHaveBeenCalledTimes(1)
  })
})
