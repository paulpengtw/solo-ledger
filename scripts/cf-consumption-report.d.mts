export interface GraphQLGroup {
  dimensions: {
    datetimeHour: string
    scriptName: string
    status: number
  }
  sum: {
    requests: number
  }
}

export interface HourlyRow {
  hour: string
  requests: number
  byStatus: Record<string, number>
}

export interface ConsumptionReport {
  totalRequests: number
  capPercent: number
  hourlyRows: HourlyRow[]
  scriptNames: string[]
}

export function aggregateReport(
  groups: GraphQLGroup[],
  options?: { cap?: number; now?: Date },
): ConsumptionReport
