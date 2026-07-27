type CheckResult = { ok: true; exp: number } | { ok: false }

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
    const milliseconds = Math.max(0, (result.exp - 60 - now()) * 1000)
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
