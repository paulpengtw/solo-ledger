import { describe, it, expect } from 'vitest'
import { aggregateReport } from '../scripts/cf-consumption-report.mjs'

// Fixture: three hours with mixed status values.
// Hour A: 120 total (80 × 200, 40 × 500)
// Hour B: 40,000 total (all 200) — simulates a loop spike
// Hour C: 55 total (50 × 200, 5 × 404)
// Grand total: 40,175
const fixture = [
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

describe('aggregateReport', () => {
  it('returns totalRequests = 40,175 for the three-hour fixture', () => {
    const report = aggregateReport(fixture)
    expect(report.totalRequests).toBe(40_175)
  })

  it('returns capPercent ≈ 40.175 (numeric, two decimal places when rounded)', () => {
    const report = aggregateReport(fixture, { cap: 100_000 })
    // Accept the full numeric value; caller formats display precision
    expect(report.capPercent).toBeCloseTo(40.175, 2)
  })

  it('returns hourly rows in ascending order', () => {
    const report = aggregateReport(fixture)
    const hours = report.hourlyRows.map(r => r.hour)
    expect(hours).toEqual([
      '2026-07-27T00:00:00Z',
      '2026-07-27T01:00:00Z',
      '2026-07-27T02:00:00Z',
    ])
  })

  it('aggregates per-hour totals correctly', () => {
    const report = aggregateReport(fixture)
    expect(report.hourlyRows[0]?.requests).toBe(120)
    expect(report.hourlyRows[1]?.requests).toBe(40_000)
    expect(report.hourlyRows[2]?.requests).toBe(55)
  })

  it('aggregates status breakdown within each hour', () => {
    const report = aggregateReport(fixture)
    expect(report.hourlyRows[0]?.byStatus).toEqual({ '200': 80, '500': 40 })
    expect(report.hourlyRows[2]?.byStatus).toEqual({ '200': 50, '404': 5 })
  })

  it('collects unique script names', () => {
    const report = aggregateReport(fixture)
    expect(report.scriptNames).toEqual(['solo-ledger'])
  })

  it('returns empty collections when given no groups', () => {
    const report = aggregateReport([])
    expect(report.totalRequests).toBe(0)
    expect(report.capPercent).toBe(0)
    expect(report.hourlyRows).toEqual([])
    expect(report.scriptNames).toEqual([])
  })

  it('uses the provided cap when computing capPercent', () => {
    const report = aggregateReport(fixture, { cap: 200_000 })
    expect(report.capPercent).toBeCloseTo(20.0875, 3)
  })
})
