export interface GraphQLGroup {
  dimensions: {
    datetimeHour: string
    scriptName: string
    status?: string
  }
  sum: {
    requests: number
  }
}

export interface HourlyRow {
  hour: string
  requests: number
  byOutcome: Record<string, number>
}

export interface ConsumptionReport {
  totalRequests: number
  todayRequests: number
  capPercent: number
  hourlyRows: HourlyRow[]
  scriptNames: string[]
}

export function aggregateReport(
  groups: GraphQLGroup[],
  options?: { cap?: number; now?: Date },
): ConsumptionReport
