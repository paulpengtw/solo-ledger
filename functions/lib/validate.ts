export type Transaction = {
  type: '支出' | '收入' | '轉帳'
  amount: number
  date: string
  description: string
  time?: string
  account?: string
  toAccount?: string
  category?: string
  payee?: string
  currency?: string
  iou?: '應收' | '應付'
}

type ValidationResult =
  | { ok: true; transaction: Transaction }
  | { ok: false; error: string }

type TransactionDateRangeValidationResult =
  | { ok: true; date_from: string; date_to: string }
  | { ok: false; error: string }

const TYPES = new Set(['支出', '收入', '轉帳'])
const IOU_TYPES = new Set(['應收', '應付'])
const OPTIONAL_STRING_FIELDS = [
  'account',
  'toAccount',
  'category',
  'payee',
  'currency',
] as const

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function isRealDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12) return false

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1] ?? 0
  return day >= 1 && day <= daysInMonth
}

export function validateTransactionDateRange(
  input: unknown,
): TransactionDateRangeValidationResult {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'invalid date_from' }
  }
  const candidate = input as Record<string, unknown>

  if (!isRealDate(candidate.date_from)) {
    return { ok: false, error: 'invalid date_from' }
  }
  if (!isRealDate(candidate.date_to)) {
    return { ok: false, error: 'invalid date_to' }
  }
  if (candidate.date_from > candidate.date_to) {
    return { ok: false, error: 'date_from later than date_to' }
  }

  return {
    ok: true,
    date_from: candidate.date_from,
    date_to: candidate.date_to,
  }
}

function isRealTime(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) return false

  const hours = Number(match[1])
  const minutes = Number(match[2])
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59
}

export function validateTransaction(input: unknown): ValidationResult {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'invalid transaction' }
  }
  const candidate = input as Record<string, unknown>

  if (typeof candidate.type !== 'string' || !TYPES.has(candidate.type)) {
    return { ok: false, error: 'invalid type' }
  }
  if (
    typeof candidate.amount !== 'number'
    || !Number.isFinite(candidate.amount)
    || candidate.amount <= 0
  ) {
    return { ok: false, error: 'invalid amount' }
  }
  if (!isRealDate(candidate.date)) {
    return { ok: false, error: 'invalid date' }
  }
  if (candidate.time !== undefined && !isRealTime(candidate.time)) {
    return { ok: false, error: 'invalid time' }
  }
  if (
    typeof candidate.description !== 'string'
    || candidate.description.trim() === ''
  ) {
    return { ok: false, error: 'missing description' }
  }

  for (const field of OPTIONAL_STRING_FIELDS) {
    const value = candidate[field]
    if (
      value !== undefined
      && (typeof value !== 'string' || value.trim() === '')
    ) {
      return { ok: false, error: `invalid ${field}` }
    }
  }

  if (
    candidate.iou !== undefined
    && (
      typeof candidate.iou !== 'string'
      || !IOU_TYPES.has(candidate.iou)
    )
  ) {
    return { ok: false, error: 'invalid iou' }
  }

  const transaction: Transaction = {
    type: candidate.type as Transaction['type'],
    amount: candidate.amount,
    date: candidate.date,
    description: candidate.description,
  }
  if (typeof candidate.time === 'string') transaction.time = candidate.time
  if (typeof candidate.account === 'string') {
    transaction.account = candidate.account
  }
  if (typeof candidate.toAccount === 'string') {
    transaction.toAccount = candidate.toAccount
  }
  if (typeof candidate.category === 'string') {
    transaction.category = candidate.category
  }
  if (typeof candidate.payee === 'string') transaction.payee = candidate.payee
  if (typeof candidate.currency === 'string') {
    transaction.currency = candidate.currency
  }
  if (typeof candidate.iou === 'string') {
    transaction.iou = candidate.iou as Transaction['iou']
  }

  return { ok: true, transaction }
}
