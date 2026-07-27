type CheckResult = { ok: true; exp: number } | { ok: false }

// The guard never schedules timers — Access sessions outlast the 32-bit setTimeout
// ceiling (see the 2026-07-27 outage). Expiry surfaces on the next gated check.
// This gate bounds re-checks to <= 289/day/client (1 startup + one per 5-min window).
const MIN_CHECK_INTERVAL_SECONDS = 300

export function startSessionGuard(deps: {
  check: () => Promise<CheckResult>
  onExpired: () => void
  now?: () => number
}): { onVisible: () => void; stop: () => void } {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  let stopped = false
  // -Infinity ensures the startup call always passes the gate on first run
  let lastCheckSeconds = -Infinity

  function requestCheck(): void {
    if (stopped) return
    const currentTime = now()
    if (currentTime - lastCheckSeconds < MIN_CHECK_INTERVAL_SECONDS) return
    lastCheckSeconds = currentTime
    void runCheck()
  }

  async function runCheck(): Promise<void> {
    if (stopped) return
    const result = await deps.check()
    if (stopped) return
    if (!result.ok) {
      deps.onExpired()
      return
    }
  }

  requestCheck()

  return {
    onVisible: () => { requestCheck() },
    stop: () => {
      stopped = true
    },
  }
}
