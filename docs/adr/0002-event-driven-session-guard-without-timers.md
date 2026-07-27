# ADR 0002: Event-Driven Session Guard Without Timers

## Status

Accepted

## Context

`DEPLOY.md` mandates a one-month Cloudflare Access session (730 h). The previous session guard scheduled a `setTimeout` callback at `(exp - 60 - now) * 1000` milliseconds — roughly 2,591,940,000 ms into the future. JavaScript's `setTimeout` stores its delay as a 32-bit signed integer, giving a ceiling of 2,147,483,647 ms (~24.8 days). Any delay that exceeds this ceiling is clamped by browsers and Node.js to approximately 1 ms, causing the callback to fire immediately and re-arm the same overflowing timer.

On 2026-07-27 this turned the guard's expiry timer into a self-re-arming loop at roughly 10–15 requests per second per open client (#24). The Cloudflare free tier's hard daily cap of 100,000 Functions requests was exhausted in approximately 2.5 hours, at which point Cloudflare began serving its limit page on every `/api/*` route. The only available remedy at the time was to delete the production Pages project to halt the traffic — an action that also destroyed the project's four environment variables and required a full rebuild to restore service (#25, #26). The cost of recreating a Pages project is described in ADR 0001.

The free-tier request budget (100,000 requests/day) is therefore a hard operating constraint, not a guideline, and any scheduling mechanism that can silently violate it is a production risk.

## Decision

The session guard (`src/auth.ts`) schedules no timers — neither a timer aimed at token expiry nor a periodic heartbeat. All triggers (startup and `visibilitychange` events) funnel through a single gate that enforces `MIN_CHECK_INTERVAL_SECONDS = 300`. The gate bounds the guard's request rate to at most 289 checks per day per client (1 startup check plus one per 5-minute window). The gate also resyncs when the wall clock steps backward so a non-monotonic clock cannot artificially extend the quiet period.

Session expiry surfaces lazily: on the next gated check triggered by a user action, or on a failed API call. There is no precise timer at `exp` and no background polling.

The deliberate absence of a timer is not an oversight. Scheduling a precise timer at `exp` is exactly the change that caused the 2026-07-27 outage. **The trade-off is explicit: expiry-detection precision was exchanged for a bounded request budget.** Future contributors must not add timers to `src/auth.ts` or to any code path that calls it; this document records why.

## Alternatives Considered

### Precise timer at `exp`

Schedule a single `setTimeout` to fire just before the JWT expires, redirecting the user to re-authenticate at that exact moment.

Reasons not chosen:

- **This is the implementation that caused the 2026-07-27 outage.** Access sessions are one month long; any computed delay for a fresh token exceeds the 32-bit `setTimeout` ceiling, is clamped to ~1 ms, and produces a self-re-arming loop at network speed.
- **There is no safe way to express the delay.** Even capping the delay to the 32-bit ceiling (~24.8 days) and re-arming on callback still requires a scheduled-timer mechanism, reintroducing the class of bug this ADR exists to fence off.

### Capped re-check timer chain (24-hour hops)

Fire a timer at `min(exp, now + 24 h)`. If the hop did not reach `exp`, re-arm another 24-hour timer (#24's interim fix).

Reasons not chosen:

- **The budget grows with the number of open clients.** Every connected tab contributes one check per 24-hour hop; an unusual number of open tabs raises steady-state consumption in a way that is not visible in the code.
- **The mechanism retains the scheduling bug class.** Any chain of re-arming timers can be disrupted by a future edit that changes the cap arithmetic, silently reproducing an overflow scenario. The goal of this decision is to make the scheduling constraint a code property, not a runtime arithmetic check.
- **Expiry still surfaces lazily in this scheme.** The timer fires at most once per 24 hours, so a session that expires between hops is not surfaced until the next hop or a user action — the same latency this scheme was meant to avoid, just at coarser granularity.

### 60-second heartbeat

Keep a recurring 1-minute timer that checks the session status in the background (#25 documents this as the pre-consolidation floor).

Reasons not chosen:

- **It generates 1,440 requests per day per open client from pure polling.** Against a one-month Access session, the check will return `ok` 99.9 % of the time; that traffic buys nothing a `visibilitychange` check does not already provide at zero background cost.
- **It does not eliminate the expiry-timer path.** The heartbeat was used alongside the expiry timer, not instead of it; removing the heartbeat without also removing the timer leaves the overflow bug intact.

## Consequences

- **Request budget is a code property.** The gate at `MIN_CHECK_INTERVAL_SECONDS = 300` enforces a ceiling of 289 checks per day per client regardless of session length. This bound holds even if the Access session policy is changed.
- **Expiry staleness is bounded by user attention.** A foregrounded, untouched tab learns of session expiry only via the next user-triggered visibility event or a failed API call. For a single-user PWA used interactively, this latency is acceptable; the user who made the last action will see the re-auth redirect before or immediately after their next action.
- **Future contributors must not add timers to the guard.** Any `setTimeout` or `setInterval` call in `src/auth.ts`, or in code that wraps or re-implements the guard, risks reintroducing the scheduling overflow. This ADR is the standing record of that constraint.
- **No contradiction with ADR 0001.** ADR 0001 records why the Cloudflare Pages project uses direct-upload mode and why recreating it is expensive. The 2026-07-27 outage is the event that made recreation necessary; ADR 0001 explains why that remediation was costly, and this ADR explains the constraint introduced to prevent a recurrence.
