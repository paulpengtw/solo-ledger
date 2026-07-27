type CheckResult = { ok: true; exp: number } | { ok: false }

// 32-bit setTimeout ceiling: delays >= 2^31 ms get clamped to ~1 ms by browsers,
// causing an immediate re-arm loop. Cap to 24 h (well below the ceiling).
const MAX_DELAY_MS = 86_400_000

export function startSessionGuard(deps: {
  check: () => Promise<CheckResult>
  onExpired: () => void
  now?: () => number
}): { onVisible: () => void; stop: () => void } {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  let expiryTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let stopped = false

  async function runCheck(): Promise<void> {
    if (stopped) return
    const result = await deps.check()
    if (stopped) return
    if (!result.ok) {
      deps.onExpired()
      return
    }
    if (expiryTimer) clearTimeout(expiryTimer)
    const delaySeconds = result.exp - 60 - now()
    // skip scheduling if exp is missing, non-finite, or already past — other triggers cover those cases
    if (!Number.isFinite(delaySeconds) || delaySeconds <= 0) return
    const milliseconds = Math.min(MAX_DELAY_MS, delaySeconds * 1000)
    expiryTimer = setTimeout(() => { void runCheck() }, milliseconds)
  }

  void runCheck()
  heartbeat = setInterval(() => { void runCheck() }, 60_000)

  return {
    onVisible: () => { void runCheck() },
    stop: () => {
      stopped = true
      if (expiryTimer) clearTimeout(expiryTimer)
      if (heartbeat) clearInterval(heartbeat)
    },
  }
}
