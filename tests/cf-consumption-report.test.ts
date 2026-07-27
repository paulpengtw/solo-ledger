import { describe, it, expect } from 'vitest'
import { aggregateReport } from '../scripts/cf-consumption-report.mjs'

// "today" anchor used across all tests.
// With now = 2026-07-27T03:30:00Z, todayStart = 2026-07-27T00:00:00Z.
const BASE_NOW = new Date('2026-07-27T03:30:00Z')

// Main fixture: four hours spanning two UTC calendar days.
//   Yesterday T23 : 30 total (30 × 200) — before today 00:00 UTC
//   Today T00     : 120 total (80 × 200, 40 × 500)
//   Today T01     : 40,000 total (all 200) — simulates a loop spike
//   Today T02     : 55 total (50 × 200, 5 × 404)
//
// Rolling 24 h total  : 40,205
// Today's total (UTC) : 40,175  (T00 + T01 + T02 only)
const fixture = [
  {
    dimensions: { datetimeHour: '2026-07-26T23:00:00Z', scriptName: 'solo-ledger', status: 200 },
    sum: { requests: 30 },
  },
  {
    dimensions: { datetimeHour: '2026-07-27T00:00:00Z', scriptName: 'solo-ledger', status: 200 },
    sum: { requests: 80 },
  },
  {
    dimensions: { datetimeHour: '2026-07-27T00:00:00Z', scriptName: 'solo-ledger', status: 500 },
    sum: { requests: 40 },
  },
  {
    dimensions: { datetimeHour: '2026-07-27T01:00:00Z', scriptName: 'solo-ledger', status: 200 },
    sum: { requests: 40_000 },
  },
  {
    dimensions: { datetimeHour: '2026-07-27T02:00:00Z', scriptName: 'solo-ledger', status: 200 },
    sum: { requests: 50 },
  },
  {
    dimensions: { datetimeHour: '2026-07-27T02:00:00Z', scriptName: 'solo-ledger', status: 404 },
    sum: { requests: 5 },
  },
]

// Out-of-order fixture: same hours as the first three in fixture but fed in
// T02 → T00 → T01 order. Used to verify the sort is non-tautological — this
// test would fail if the .sort() call were removed from aggregateReport.
const outOfOrderFixture = [
  {
    dimensions: { datetimeHour: '2026-07-27T02:00:00Z', scriptName: 'solo-ledger', status: 200 },
    sum: { requests: 55 },
  },
  {
    dimensions: { datetimeHour: '2026-07-27T00:00:00Z', scriptName: 'solo-ledger', status: 200 },
    sum: { requests: 120 },
  },
  {
    dimensions: { datetimeHour: '2026-07-27T01:00:00Z', scriptName: 'solo-ledger', status: 200 },
    sum: { requests: 40_000 },
  },
]

describe('aggregateReport', () => {
  it('returns totalRequests = 40,205 (rolling 24 h including yesterday T23)', () => {
    const report = aggregateReport(fixture, { now: BASE_NOW })
    expect(report.totalRequests).toBe(40_205)
  })

  it('returns todayRequests = 40,175 (only hours on 2026-07-27 UTC)', () => {
    const report = aggregateReport(fixture, { now: BASE_NOW })
    expect(report.todayRequests).toBe(40_175)
  })

  it('todayRequests differs from totalRequests — exercises the cross-midnight split', () => {
    const report = aggregateReport(fixture, { now: BASE_NOW })
    expect(report.todayRequests).not.toBe(report.totalRequests)
  })

  it('capPercent uses todayRequests as numerator (≈ 40.175 against 100,000 cap)', () => {
    const report = aggregateReport(fixture, { cap: 100_000, now: BASE_NOW })
    expect(report.capPercent).toBeCloseTo(40.175, 2)
  })

  it('sorts hourly rows ascending even when input arrives out of order', () => {
    const report = aggregateReport(outOfOrderFixture)
    const hours = report.hourlyRows.map(r => r.hour)
    expect(hours).toEqual([
      '2026-07-27T00:00:00Z',
      '2026-07-27T01:00:00Z',
      '2026-07-27T02:00:00Z',
    ])
  })

  it('aggregates per-hour totals correctly', () => {
    const report = aggregateReport(fixture, { now: BASE_NOW })
    expect(report.hourlyRows[0]?.requests).toBe(30)     // yesterday T23
    expect(report.hourlyRows[1]?.requests).toBe(120)    // today T00
    expect(report.hourlyRows[2]?.requests).toBe(40_000) // today T01
    expect(report.hourlyRows[3]?.requests).toBe(55)     // today T02
  })

  it('aggregates status breakdown within each hour', () => {
    const report = aggregateReport(fixture, { now: BASE_NOW })
    expect(report.hourlyRows[0]?.byStatus).toEqual({ '200': 30 })
    expect(report.hourlyRows[1]?.byStatus).toEqual({ '200': 80, '500': 40 })
    expect(report.hourlyRows[3]?.byStatus).toEqual({ '200': 50, '404': 5 })
  })

  it('groups a missing status dimension under "unknown"', () => {
    const withMissingStatus = [
      {
        dimensions: { datetimeHour: '2026-07-27T05:00:00Z', scriptName: 'solo-ledger', status: undefined },
        sum: { requests: 7 },
      },
    ]
    const report = aggregateReport(withMissingStatus)
    expect(report.hourlyRows[0]?.byStatus).toEqual({ unknown: 7 })
  })

  it('collects unique script names', () => {
    const report = aggregateReport(fixture, { now: BASE_NOW })
    expect(report.scriptNames).toEqual(['solo-ledger'])
  })

  it('returns empty collections when given no groups', () => {
    const report = aggregateReport([], { now: BASE_NOW })
    expect(report.totalRequests).toBe(0)
    expect(report.todayRequests).toBe(0)
    expect(report.capPercent).toBe(0)
    expect(report.hourlyRows).toEqual([])
    expect(report.scriptNames).toEqual([])
  })

  it('uses the provided cap when computing capPercent', () => {
    const report = aggregateReport(fixture, { cap: 200_000, now: BASE_NOW })
    // todayRequests = 40,175 → 40,175 / 200,000 × 100 = 20.0875
    expect(report.capPercent).toBeCloseTo(20.0875, 3)
  })
})
