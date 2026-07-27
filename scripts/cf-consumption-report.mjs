/**
 * Cloudflare Pages Function consumption report — last 24 hours.
 *
 * Usage:
 *   set -a && . ./.env && set +a
 *   node scripts/cf-consumption-report.mjs
 *
 * Required environment variables:
 *   CLOUDFLARE_API_TOKEN   — API token with Account > Account Analytics > Read
 *   CLOUDFLARE_ACCOUNT_ID  — Cloudflare account ID (hex string in dashboard URL)
 *
 * CAVEAT (pages.dev-only project):
 *   Because this project owns no zone, no per-URL-path dimension is available in
 *   the GraphQL Analytics API. The report is per Pages Function (scriptName) by
 *   hour and HTTP status. The app has exactly one function handling /api/[action],
 *   and auth-check is the only automatically-issued action, so an hourly spike in
 *   "total requests" IS the loop signal. True per-action breakdown would require
 *   the paid Cloudflare Logs product. Daily cap resets at 00:00 UTC; query buckets
 *   are UTC-aligned to match.
 */

import { pathToFileURL } from 'node:url'

const FREE_DAILY_CAP = 100_000

/**
 * Aggregate raw GraphQL group records into a structured report.
 *
 * @param {Array<{dimensions: {datetimeHour: string, scriptName: string, status: number}, sum: {requests: number}}>} groups
 * @param {{ cap?: number, now?: Date }} options
 * @returns {{ totalRequests: number, capPercent: number, hourlyRows: Array<{hour: string, requests: number, byStatus: Record<string, number>}>, scriptNames: string[] }}
 */
export function aggregateReport(groups, { cap = FREE_DAILY_CAP, now = new Date() } = {}) {
  // Bucket by hour
  /** @type {Map<string, {requests: number, byStatus: Record<string, number>}>} */
  const byHour = new Map()
  const scriptNameSet = new Set()

  for (const group of groups) {
    const { datetimeHour, scriptName, status } = group.dimensions
    const requests = group.sum.requests

    scriptNameSet.add(scriptName)

    const existing = byHour.get(datetimeHour)
    if (existing) {
      existing.requests += requests
      existing.byStatus[String(status)] = (existing.byStatus[String(status)] ?? 0) + requests
    } else {
      byHour.set(datetimeHour, {
        requests,
        byStatus: { [String(status)]: requests },
      })
    }
  }

  // Sort hours ascending
  const sortedHours = Array.from(byHour.keys()).sort()
  const hourlyRows = sortedHours.map(hour => {
    const bucket = byHour.get(hour)
    return {
      hour,
      requests: bucket.requests,
      byStatus: bucket.byStatus,
    }
  })

  const totalRequests = hourlyRows.reduce((sum, row) => sum + row.requests, 0)
  const capPercent = totalRequests / cap * 100

  return {
    totalRequests,
    capPercent,
    hourlyRows,
    scriptNames: Array.from(scriptNameSet).sort(),
  }
}

async function main() {
  const token = process.env['CLOUDFLARE_API_TOKEN']
  const accountId = process.env['CLOUDFLARE_ACCOUNT_ID']

  if (!token || !accountId) {
    const missing = [
      !token && 'CLOUDFLARE_API_TOKEN',
      !accountId && 'CLOUDFLARE_ACCOUNT_ID',
    ].filter(Boolean).join(', ')
    console.error(`Missing required environment variable(s): ${missing}`)
    console.error('Hint: set -a && . ./.env && set +a')
    process.exit(1)
  }

  const now = new Date()
  // 24 h ago, truncated to the start of that UTC hour for clean alignment
  const since = new Date(now)
  since.setUTCHours(since.getUTCHours() - 24, 0, 0, 0)

  // NOTE (pages.dev-only project): no zone ownership means no per-URL-path
  // dimension is available. We query pagesFunctionsInvocationsAdaptiveGroups
  // per scriptName + status + datetimeHour. An hourly spike IS the loop signal.
  // True per-action breakdown requires paid Cloudflare Logs. See also DEPLOY.md.
  const query = /* GraphQL */ `
    query ConsumptionReport($accountTag: string!, $since: string!, $until: string!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          pagesFunctionsInvocationsAdaptiveGroups(
            limit: 10000
            filter: { datetime_geq: $since, datetime_leq: $until }
            orderBy: [datetimeHour_ASC]
          ) {
            dimensions {
              datetimeHour
              scriptName
              status
            }
            sum {
              requests
            }
          }
        }
      }
    }
  `

  const variables = {
    accountTag: accountId,
    since: since.toISOString(),
    until: now.toISOString(),
  }

  let data
  try {
    const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    })

    if (!response.ok) {
      console.error(`HTTP ${response.status} ${response.statusText}`)
      process.exit(1)
    }

    data = await response.json()
  } catch (err) {
    console.error('Network error:', err.message)
    process.exit(1)
  }

  if (data.errors && data.errors.length > 0) {
    console.error('GraphQL errors:')
    for (const err of data.errors) {
      console.error(JSON.stringify(err, null, 2))
    }
    const isAuthDenied = data.errors.some(e =>
      (e.message ?? '').toLowerCase().includes('authorization denied') ||
      (e.extensions?.code ?? '').toLowerCase().includes('authorization')
    )
    if (isAuthDenied) {
      console.error(
        '\nHint: the API token needs "Account > Account Analytics > Read" added.\n' +
        'See .env.example for the minimum required scopes.'
      )
    }
    process.exit(1)
  }

  const accounts = data?.data?.viewer?.accounts
  if (!accounts || accounts.length === 0) {
    console.error('No account data returned. Check CLOUDFLARE_ACCOUNT_ID.')
    process.exit(1)
  }

  const groups = accounts[0].pagesFunctionsInvocationsAdaptiveGroups ?? []

  const report = aggregateReport(groups, { cap: FREE_DAILY_CAP, now })

  const windowLabel = `${since.toISOString().slice(0, 16)}Z – ${now.toISOString().slice(0, 16)}Z`
  console.log(`\nCloudflare Pages Function consumption report`)
  console.log(`Window : ${windowLabel} (last 24 h)`)
  if (report.scriptNames.length > 0) {
    console.log(`Function(s): ${report.scriptNames.join(', ')}`)
  }
  console.log()

  if (report.hourlyRows.length === 0) {
    console.log('No invocations recorded in this window.')
  } else {
    // Hourly table
    const headerHour = 'Hour (UTC)'.padEnd(18)
    const headerReq  = 'Requests'.padStart(10)
    const headerStatus = '  Status breakdown'
    console.log(`${headerHour}${headerReq}${headerStatus}`)
    console.log('-'.repeat(70))

    let warnings = []
    for (const row of report.hourlyRows) {
      const hourStr = row.hour.replace('T', ' ').slice(0, 16)
      const reqStr = String(row.requests).padStart(10)
      const statusStr = Object.entries(row.byStatus)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([s, n]) => `${s}:${n}`)
        .join(' ')
      console.log(`${hourStr.padEnd(18)}${reqStr}  ${statusStr}`)
      if (row.requests > 1000) {
        warnings.push(`  WARNING: ${hourStr} UTC had ${row.requests.toLocaleString()} requests (>1,000 — possible request loop)`)
      }
    }
    console.log('-'.repeat(70))
  }

  const pct = report.capPercent.toFixed(1)
  console.log(`\nTotal  : ${report.totalRequests.toLocaleString()} requests`)
  console.log(`Consumption: ${report.totalRequests.toLocaleString()} of ${FREE_DAILY_CAP.toLocaleString()} daily free-tier requests (${pct}%)`)
  console.log()

  // Health verdict
  // Single-user traffic is roughly < 500/day. The auth-check session guard is
  // bounded at <= 289 checks/day/client (per src/auth.ts MIN_CHECK_INTERVAL_SECONDS=300).
  const warningHours = report.hourlyRows.filter(r => r.requests > 1000)
  if (warningHours.length > 0) {
    console.log('HEALTH: WARNING')
    for (const row of warningHours) {
      const hourStr = row.hour.replace('T', ' ').slice(0, 16)
      console.log(`  WARNING: ${hourStr} UTC had ${row.requests.toLocaleString()} requests in a single hour`)
      console.log('  This exceeds 1,000/hour — consistent with a request loop (e.g. the 2026-07-27')
      console.log('  loop burned ~40,000 requests/hour). Investigate immediately.')
    }
  } else if (report.totalRequests > 500) {
    console.log('HEALTH: ELEVATED — total exceeds expected single-user range (<500/day)')
    console.log('  No single hour exceeded 1,000; may be normal multi-session usage.')
  } else {
    console.log('HEALTH: OK — traffic is within expected single-user range (<500/day)')
    console.log('  (auth-check alone is bounded at <=289 checks/day/client per src/auth.ts)')
  }

  console.log()
}

// Run main() only when executed directly (not when imported as a module)
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
