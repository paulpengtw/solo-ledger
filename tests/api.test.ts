import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OPTIONS_CACHE_KEY,
  listTransactions,
  loadOptions,
  submitTransaction,
} from '../src/api'
import * as ApiModule from '../src/api'
import {
  CACHED_OPTIONS,
  RECEIVABLE_GROUPS,
  RECENT_TRANSACTIONS,
  REFRESHED_OPTIONS,
  WIRE_CACHED_OPTIONS,
  WIRE_REFRESHED_OPTIONS,
} from './pwa-fixtures'

const KEY = '3b241101-e2bb-4255-8caf-4136c566a962'
const TRANSACTION = {
  type: '支出' as const,
  amount: 260,
  date: '2026-07-27',
  description: '晚餐',
  account: '錢包',
  category: '餐飲',
  currency: 'TWD',
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('submitTransaction', () => {
  it('POSTs exactly the Pages Function contract accepted by validate.ts', async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('/api/create_transaction')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({
        transaction: TRANSACTION,
        idempotencyKey: KEY,
      })
      const body = JSON.parse(String(init?.body)) as {
        transaction: Record<string, unknown>
      }
      expect(typeof body.transaction.amount).toBe('number')
      expect(body.transaction.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(body.transaction).not.toHaveProperty('toAccount')
      return jsonResponse(200, { ok: true, txn_id: KEY })
    }) as unknown as typeof fetch

    await expect(submitTransaction(TRANSACTION, KEY, fetchFn)).resolves.toEqual({
      ok: true,
      alreadyRecorded: false,
    })
  })

  it('treats already:true as idempotent success', async () => {
    const fetchFn = (async () =>
      jsonResponse(200, { ok: true, already: true, txn_id: KEY })) as typeof fetch

    await expect(submitTransaction(TRANSACTION, KEY, fetchFn)).resolves.toEqual({
      ok: true,
      alreadyRecorded: true,
    })
  })

  it('aborts a request after 15 seconds', async () => {
    vi.useFakeTimers()
    const fetchFn = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })) as unknown as typeof fetch

    const request = submitTransaction(TRANSACTION, KEY, fetchFn)
    await vi.advanceTimersByTimeAsync(15_000)

    await expect(request).resolves.toEqual({
      ok: false,
      kind: 'network',
      message: '連線逾時，請再試一次',
    })
  })
})

describe('expired-session classification', () => {
  const opaqueRedirect = (): Response => ({
    type: 'opaqueredirect',
    status: 0,
    ok: false,
    json: async () => { throw new TypeError('opaque response has no body') },
  }) as unknown as Response

  it('sends every write in the programmatic shape Access answers with 401, never following redirects', async () => {
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      expect(headers['x-requested-with']).toBe('XMLHttpRequest')
      expect(init?.redirect).toBe('manual')
      return jsonResponse(200, { ok: true, txn_id: KEY })
    }) as unknown as typeof fetch

    await expect(submitTransaction(TRANSACTION, KEY, fetchFn)).resolves.toEqual({
      ok: true,
      alreadyRecorded: false,
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('classifies the unfollowed Access redirect on create_transaction as an expired session', async () => {
    const fetchFn = (async () => opaqueRedirect()) as typeof fetch

    await expect(submitTransaction(TRANSACTION, KEY, fetchFn)).resolves.toEqual({
      ok: false,
      kind: 'auth',
      message: '登入已過期',
    })
  })

  it('classifies the unfollowed Access redirect on settle as an expired session', async () => {
    const fetchFn = (async () => opaqueRedirect()) as typeof fetch

    await expect(ApiModule.settleReceivable({
      txn_id: 'receivable-open-001',
      account: '錢包',
      date: '2026-07-27',
      amount: 200,
    }, KEY, fetchFn)).resolves.toEqual({
      ok: false,
      kind: 'auth',
      message: '登入已過期',
    })
  })

  it('classifies the unfollowed Access redirect on reverse_transaction as an expired session', async () => {
    const fetchFn = (async () => opaqueRedirect()) as typeof fetch

    await expect(ApiModule.reverseTransaction({
      txn_id: 'txn-recent',
      date: '2026-07-27',
    }, KEY, fetchFn)).resolves.toEqual({
      ok: false,
      kind: 'auth',
      message: '登入已過期',
    })
  })

  it('keeps a genuine offline failure distinct: fetch rejection stays a network error', async () => {
    const fetchFn = (async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof fetch

    await expect(submitTransaction(TRANSACTION, KEY, fetchFn)).resolves.toEqual({
      ok: false,
      kind: 'network',
      message: '沒有網路連線，請再試一次',
    })
  })
})

describe('loadOptions', () => {
  it('returns localStorage cache synchronously then refreshes and updates it in the background', async () => {
    const storage = memoryStorage()
    storage.setItem(OPTIONS_CACHE_KEY, JSON.stringify(WIRE_CACHED_OPTIONS))
    const onRefresh = vi.fn()
    const fetchFn = (async (url: RequestInfo | URL) => {
      expect(String(url)).toBe('/api/get_options')
      return jsonResponse(200, WIRE_REFRESHED_OPTIONS)
    }) as typeof fetch

    const loaded = loadOptions({ storage, fetchFn, onRefresh })

    expect(loaded.cached).toEqual(CACHED_OPTIONS)
    expect(onRefresh).not.toHaveBeenCalled()

    await expect(loaded.refresh).resolves.toEqual(REFRESHED_OPTIONS)
    expect(onRefresh).toHaveBeenCalledWith(REFRESHED_OPTIONS)
    expect(JSON.parse(storage.getItem(OPTIONS_CACHE_KEY)!)).toEqual(WIRE_REFRESHED_OPTIONS)
  })
})

describe('listTransactions', () => {
  it('POSTs the inclusive date range and returns the exact string rows', async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('/api/list_transactions')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({
        date_from: '0001-01-01',
        date_to: '9999-12-31',
      })
      return jsonResponse(200, RECENT_TRANSACTIONS)
    }) as unknown as typeof fetch

    await expect(
      listTransactions('0001-01-01', '9999-12-31', fetchFn),
    ).resolves.toEqual(RECENT_TRANSACTIONS)
  })
})

describe('receivables API', () => {
  it('POSTs list_receivables and accepts the grouped arithmetic response', async () => {
    const listReceivables = (
      ApiModule as typeof ApiModule & {
        listReceivables?: (
          fetchFn: typeof fetch,
        ) => Promise<unknown>
      }
    ).listReceivables
    expect(listReceivables).toBeTypeOf('function')
    if (!listReceivables) return
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('/api/list_receivables')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({})
      return jsonResponse(200, RECEIVABLE_GROUPS)
    }) as unknown as typeof fetch

    await expect(listReceivables(fetchFn)).resolves.toEqual(RECEIVABLE_GROUPS)
  })

  it('POSTs settle without a currency field and maps success like other mutations', async () => {
    const settleReceivable = (
      ApiModule as typeof ApiModule & {
        settleReceivable?: (
          settlement: Record<string, unknown>,
          idempotencyKey: string,
          fetchFn: typeof fetch,
        ) => Promise<unknown>
      }
    ).settleReceivable
    expect(settleReceivable).toBeTypeOf('function')
    if (!settleReceivable) return
    const settlement = {
      txn_id: 'receivable-open-001',
      account: '錢包',
      date: '2026-07-27',
      amount: 200,
    }
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('/api/settle')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({
        ...settlement,
        idempotencyKey: KEY,
      })
      expect(JSON.parse(String(init?.body))).not.toHaveProperty('currency')
      return jsonResponse(200, { ok: true, txn_id: KEY })
    }) as unknown as typeof fetch

    await expect(
      settleReceivable(settlement, KEY, fetchFn),
    ).resolves.toEqual({
      ok: true,
      alreadyRecorded: false,
    })
  })
})

describe('write response safety', () => {
  it('does not treat an error with already:true as success', async () => {
    const fetchFn = (async () => new Response(
      JSON.stringify({ ok: false, already: true, error: 'outcome unknown' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch
    await expect(submitTransaction(TRANSACTION, KEY, fetchFn)).resolves.toEqual({
      ok: false,
      kind: 'backend',
      message: 'outcome unknown',
    })
  })
})

describe('reverseTransaction', () => {
  it('POSTs the reversal without a currency field and maps success like other mutations', async () => {
    const reverseTransaction = (
      ApiModule as typeof ApiModule & {
        reverseTransaction?: (
          reversal: Record<string, unknown>,
          idempotencyKey: string,
          fetchFn: typeof fetch,
        ) => Promise<unknown>
      }
    ).reverseTransaction
    expect(reverseTransaction).toBeTypeOf('function')
    if (!reverseTransaction) return

    const reversal = {
      txn_id: 'txn-recent',
      date: '2026-07-27',
    }
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('/api/reverse_transaction')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({
        ...reversal,
        idempotencyKey: KEY,
      })
      expect(JSON.parse(String(init?.body))).not.toHaveProperty('currency')
      return jsonResponse(200, { ok: true, txn_id: KEY })
    }) as unknown as typeof fetch

    await expect(
      reverseTransaction(reversal, KEY, fetchFn),
    ).resolves.toEqual({
      ok: true,
      alreadyRecorded: false,
    })
  })
})
