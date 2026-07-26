import type { Transaction } from './state'

export type AccountOption = {
  name: string
  type: '資產' | '負債'
  subtype: string
  sort: number
}

export type LedgerOptions = {
  schema_version: string
  accounts: AccountOption[]
  categories: {
    支出: string[]
    收入: string[]
  }
  payees: string[]
  defaults: {
    currency: string
    account: string
  }
}

export type LedgerTransaction = {
  txn_id: string
  日期: string
  時間: string
  類型: string
  借方帳戶: string
  貸方帳戶: string
  金額: string
  幣別: string
  分類: string
  對象: string
  說明: string
  結清狀態: string
}

export type ReceivableEntry = {
  txn_id: string
  日期: string
  金額: number
  幣別: string
  對象: string
  說明: string
  結清狀態: '未結' | '部分'
  direction: '應收' | '應付'
  outstanding: number
  view_only: boolean
}

export type ReceivableGroup = {
  對象: string
  entries: ReceivableEntry[]
}

export type Settlement = {
  txn_id: string
  account: string
  date: string
  amount?: number
}

export type SubmitResult =
  | { ok: true; alreadyRecorded: boolean }
  | { ok: false; kind: 'network' | 'auth' | 'backend'; message: string }

export const OPTIONS_CACHE_KEY = 'solo-ledger:get_options:v1'
const TIMEOUT_MS = 15_000

async function post(
  path: string,
  body: unknown,
  fetchFn: typeof fetch,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetchFn(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

export async function submitTransaction(
  transaction: Transaction,
  idempotencyKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<SubmitResult> {
  let response: Response
  try {
    response = await post(
      '/api/create_transaction',
      { transaction, idempotencyKey },
      fetchFn,
    )
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'AbortError'
    return {
      ok: false,
      kind: 'network',
      message: timedOut ? '連線逾時，請再試一次' : '沒有網路連線，請再試一次',
    }
  }

  if (response.status === 401) {
    return { ok: false, kind: 'auth', message: '登入已過期' }
  }

  let body: { ok?: boolean; already?: boolean; error?: string }
  try {
    body = await response.json() as typeof body
  } catch {
    return {
      ok: false,
      kind: 'backend',
      message: `伺服器錯誤 (${response.status})`,
    }
  }

  if (body.ok === true || body.already === true) {
    return { ok: true, alreadyRecorded: body.already === true }
  }
  return {
    ok: false,
    kind: 'backend',
    message: body.error ?? `伺服器錯誤 (${response.status})`,
  }
}

export async function authCheck(
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: true; exp: number } | { ok: false }> {
  try {
    const response = await post('/api/auth-check', {}, fetchFn)
    if (!response.ok) return { ok: false }
    const body = await response.json() as { ok?: boolean; exp?: number }
    if (body.ok === true && typeof body.exp === 'number') {
      return { ok: true, exp: body.exp }
    }
  } catch {
    // A failed auth check cannot prove that the session is still valid.
  }
  return { ok: false }
}

function isLedgerTransaction(value: unknown): value is LedgerTransaction {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.txn_id === 'string'
    && typeof candidate.日期 === 'string'
    && typeof candidate.時間 === 'string'
    && typeof candidate.類型 === 'string'
    && typeof candidate.借方帳戶 === 'string'
    && typeof candidate.貸方帳戶 === 'string'
    && typeof candidate.金額 === 'string'
    && typeof candidate.幣別 === 'string'
    && typeof candidate.分類 === 'string'
    && typeof candidate.對象 === 'string'
    && typeof candidate.說明 === 'string'
    && typeof candidate.結清狀態 === 'string'
  )
}

export async function listTransactions(
  dateFrom: string,
  dateTo: string,
  fetchFn: typeof fetch = fetch,
): Promise<LedgerTransaction[] | null> {
  try {
    const response = await post(
      '/api/list_transactions',
      { date_from: dateFrom, date_to: dateTo },
      fetchFn,
    )
    if (!response.ok) return null
    const body: unknown = await response.json()
    return Array.isArray(body) && body.every(isLedgerTransaction) ? body : null
  } catch {
    return null
  }
}

function isReceivableEntry(value: unknown): value is ReceivableEntry {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.txn_id === 'string'
    && typeof candidate.日期 === 'string'
    && typeof candidate.金額 === 'number'
    && Number.isFinite(candidate.金額)
    && typeof candidate.幣別 === 'string'
    && typeof candidate.對象 === 'string'
    && typeof candidate.說明 === 'string'
    && (candidate.結清狀態 === '未結' || candidate.結清狀態 === '部分')
    && (candidate.direction === '應收' || candidate.direction === '應付')
    && typeof candidate.outstanding === 'number'
    && Number.isFinite(candidate.outstanding)
    && typeof candidate.view_only === 'boolean'
  )
}

function isReceivableGroup(value: unknown): value is ReceivableGroup {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.對象 === 'string'
    && Array.isArray(candidate.entries)
    && candidate.entries.every(isReceivableEntry)
  )
}

export async function listReceivables(
  fetchFn: typeof fetch = fetch,
): Promise<ReceivableGroup[] | null> {
  try {
    const response = await post('/api/list_receivables', {}, fetchFn)
    if (!response.ok) return null
    const body: unknown = await response.json()
    return Array.isArray(body) && body.every(isReceivableGroup) ? body : null
  } catch {
    return null
  }
}

export async function settleReceivable(
  settlement: Settlement,
  idempotencyKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<SubmitResult> {
  let response: Response
  try {
    response = await post(
      '/api/settle',
      { ...settlement, idempotencyKey },
      fetchFn,
    )
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'AbortError'
    return {
      ok: false,
      kind: 'network',
      message: timedOut ? '連線逾時，請再試一次' : '沒有網路連線，請再試一次',
    }
  }

  if (response.status === 401) {
    return { ok: false, kind: 'auth', message: '登入已過期' }
  }

  let body: { ok?: boolean; already?: boolean; error?: string }
  try {
    body = await response.json() as typeof body
  } catch {
    return {
      ok: false,
      kind: 'backend',
      message: `伺服器錯誤 (${response.status})`,
    }
  }

  if (body.ok === true || body.already === true) {
    return { ok: true, alreadyRecorded: body.already === true }
  }
  return {
    ok: false,
    kind: 'backend',
    message: body.error ?? `伺服器錯誤 (${response.status})`,
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isLedgerOptions(value: unknown): value is LedgerOptions {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  const categories = candidate.categories as Record<string, unknown> | undefined
  const defaults = candidate.defaults as Record<string, unknown> | undefined
  return (
    typeof candidate.schema_version === 'string'
    && Array.isArray(candidate.accounts)
    && candidate.accounts.every(account => {
      if (typeof account !== 'object' || account === null) return false
      const item = account as Record<string, unknown>
      return (
        typeof item.name === 'string'
        && (item.type === '資產' || item.type === '負債')
        && typeof item.subtype === 'string'
        && typeof item.sort === 'number'
      )
    })
    && categories !== undefined
    && isStringArray(categories.支出)
    && isStringArray(categories.收入)
    && isStringArray(candidate.payees)
    && defaults !== undefined
    && typeof defaults.currency === 'string'
    && typeof defaults.account === 'string'
  )
}

export async function fetchOptions(
  fetchFn: typeof fetch = fetch,
): Promise<LedgerOptions | null> {
  try {
    const response = await post('/api/get_options', {}, fetchFn)
    if (!response.ok) return null
    const body: unknown = await response.json()
    return isLedgerOptions(body) ? body : null
  } catch {
    return null
  }
}

function readCachedOptions(storage: Storage | undefined): LedgerOptions | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(OPTIONS_CACHE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isLedgerOptions(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function loadOptions(deps: {
  storage?: Storage
  fetchFn?: typeof fetch
  onRefresh?: (options: LedgerOptions) => void
} = {}): {
  cached: LedgerOptions | null
  refresh: Promise<LedgerOptions | null>
} {
  const storage = deps.storage ?? (
    typeof localStorage === 'undefined' ? undefined : localStorage
  )
  const cached = readCachedOptions(storage)
  const refresh = fetchOptions(deps.fetchFn).then(options => {
    if (!options) return null
    try {
      storage?.setItem(OPTIONS_CACHE_KEY, JSON.stringify(options))
    } catch {
      // Private browsing or a full quota must not block entry.
    }
    deps.onRefresh?.(options)
    return options
  })
  return { cached, refresh }
}
