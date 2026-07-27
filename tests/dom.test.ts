// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CACHED_OPTIONS,
  RECENT_TRANSACTIONS,
  REFRESHED_OPTIONS,
} from './pwa-fixtures'

const apiMocks = vi.hoisted(() => ({
  authCheck: vi.fn(),
  listTransactions: vi.fn(),
  loadOptions: vi.fn(),
  submitTransaction: vi.fn(),
}))

vi.mock('../src/api', () => ({
  authCheck: apiMocks.authCheck,
  listTransactions: apiMocks.listTransactions,
  loadOptions: apiMocks.loadOptions,
  submitTransaction: apiMocks.submitTransaction,
}))

import { mountApp } from '../src/main'

let unmount: (() => void) | undefined

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function mount(options = CACHED_OPTIONS, refresh: Promise<unknown> = new Promise(() => {})) {
  apiMocks.loadOptions.mockReturnValue({
    cached: options,
    refresh,
  })
  unmount = mountApp(document.querySelector<HTMLElement>('#app')!, {
    today: () => '2026-07-27',
    randomUUID: () => '3b241101-e2bb-4255-8caf-4136c566a962',
  })
}

function click(selector: string): void {
  document.querySelector<HTMLButtonElement>(selector)!.click()
}

function input(selector: string, value: string): void {
  const element = document.querySelector<HTMLInputElement>(selector)!
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

function fillExpense(description = '晚餐'): void {
  for (const key of ['2', '6', '0']) click(`#keypad [data-key="${key}"]`)
  click('#account-picker [data-account="錢包"]')
  click('#category-grid [data-category="餐飲"]')
  input('#description-input', description)
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
  apiMocks.authCheck.mockReset().mockResolvedValue({
    ok: true,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })
  apiMocks.listTransactions.mockReset().mockResolvedValue(RECENT_TRANSACTIONS)
  apiMocks.loadOptions.mockReset()
  apiMocks.submitTransaction.mockReset().mockResolvedValue({
    ok: true,
    alreadyRecorded: false,
  })
})

afterEach(() => {
  unmount?.()
  unmount = undefined
  vi.useRealTimers()
})

describe('selection-first entry form', () => {
  it('renders accounts grouped by 子類型, per-type categories, and tappable 對象 suggestions', () => {
    mount()

    expect(document.querySelector('[data-subtype="現金"]')?.textContent).toContain('錢包')
    expect(document.querySelector('[data-subtype="銀行"]')?.textContent).toContain('台新銀行')
    expect(document.querySelector('[data-subtype="信用卡"]')?.textContent).toContain('國泰卡')
    expect(document.querySelector('#category-grid')?.textContent).toContain('餐飲')
    expect(document.querySelector('#category-grid')?.textContent).not.toContain('薪資')
    expect(document.querySelector('#payee-suggestions')?.textContent).toContain('全聯')

    click('#type-toggle [data-type="收入"]')
    expect(document.querySelector('#category-grid')?.textContent).toContain('薪資')
    expect(document.querySelector('#category-grid')?.textContent).not.toContain('餐飲')

    click('#type-toggle [data-type="轉帳"]')
    expect(document.querySelector('#category-section')).toHaveProperty('hidden', true)
    expect(document.querySelector('#to-account-section')).toHaveProperty('hidden', false)
  })

  it('keeps submit blocked when required 說明 is whitespace', () => {
    mount()
    fillExpense('   ')

    const submit = document.querySelector<HTMLButtonElement>('#submit-btn')!
    expect(submit.disabled).toBe(true)
    submit.click()
    expect(apiMocks.submitTransaction).not.toHaveBeenCalled()
  })

  it('posts the exact transaction contract with a UUID idempotencyKey', async () => {
    mount()
    fillExpense()
    click('#payee-suggestions [data-payee="全聯"]')

    click('#submit-btn')

    await vi.waitFor(() => expect(apiMocks.submitTransaction).toHaveBeenCalledTimes(1))
    expect(apiMocks.submitTransaction).toHaveBeenCalledWith({
      type: '支出',
      amount: 260,
      date: '2026-07-27',
      description: '晚餐',
      account: '錢包',
      category: '餐飲',
      payee: '全聯',
      currency: 'TWD',
    }, '3b241101-e2bb-4255-8caf-4136c566a962')
  })

  it('reuses the same idempotencyKey for the second request after failure', async () => {
    const randomUUID = vi.fn()
      .mockReturnValueOnce('3b241101-e2bb-4255-8caf-4136c566a962')
      .mockReturnValueOnce('a4dd45e4-4741-42bc-8750-40d3b0bbccca')
    apiMocks.loadOptions.mockReturnValue({
      cached: CACHED_OPTIONS,
      refresh: new Promise(() => {}),
    })
    apiMocks.submitTransaction
      .mockResolvedValueOnce({ ok: false, kind: 'network', message: '連線失敗' })
      .mockResolvedValueOnce({ ok: true, alreadyRecorded: false })
    unmount = mountApp(document.querySelector<HTMLElement>('#app')!, {
      today: () => '2026-07-27',
      randomUUID,
    })
    fillExpense()

    click('#submit-btn')
    await vi.waitFor(() => expect(apiMocks.submitTransaction).toHaveBeenCalledTimes(1))
    click('#submit-btn')
    await vi.waitFor(() => expect(apiMocks.submitTransaction).toHaveBeenCalledTimes(2))

    const firstKey = apiMocks.submitTransaction.mock.calls[0]![1]
    const retryKey = apiMocks.submitTransaction.mock.calls[1]![1]
    expect(retryKey).toBe(firstKey)
    expect(randomUUID).toHaveBeenCalledTimes(1)
  })

  it('shows a soft schema warning while leaving the form usable', async () => {
    const refresh = deferred<typeof REFRESHED_OPTIONS>()
    mount(CACHED_OPTIONS, refresh.promise)
    refresh.resolve(REFRESHED_OPTIONS)

    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('#schema-banner')!.hidden).toBe(false)
    })
    expect(document.querySelector('#schema-banner')?.textContent).toContain('選項已更新')

    fillExpense()
    click('#submit-btn')

    await vi.waitFor(() => expect(apiMocks.submitTransaction).toHaveBeenCalledTimes(1))
  })
})

describe('recent entries view', () => {
  it('renders list_transactions rows with a set or blank 結清狀態', async () => {
    mount()

    click('[data-view="recent"]')

    await vi.waitFor(() => expect(apiMocks.listTransactions).toHaveBeenCalledWith(
      '0001-01-01',
      '9999-12-31',
    ))
    const rows = document.querySelectorAll('.transaction-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('晚餐')
    expect(rows[0]?.textContent).toContain('260.00')
    expect(rows[1]?.textContent).toContain('手動補登')
    const statuses = document.querySelectorAll('.transaction-status')
    expect(statuses[0]?.textContent).toBe('未結')
    expect(statuses[1]?.textContent).toBe('')
  })

  it('fetches on each switch and keeps the entry form usable afterward', async () => {
    const newlyPosted = {
      ...RECENT_TRANSACTIONS[0],
      txn_id: 'txn-new',
      說明: '切換後晚餐',
    }
    apiMocks.listTransactions
      .mockResolvedValueOnce(RECENT_TRANSACTIONS)
      .mockResolvedValueOnce([newlyPosted, ...RECENT_TRANSACTIONS])
    mount()
    fillExpense('切換後晚餐')

    click('[data-view="recent"]')
    await vi.waitFor(() => expect(apiMocks.listTransactions).toHaveBeenCalledTimes(1))
    click('[data-view="entry"]')

    expect(document.querySelector<HTMLInputElement>('#description-input')?.value)
      .toBe('切換後晚餐')
    expect(document.querySelector<HTMLButtonElement>('#submit-btn')?.disabled)
      .toBe(false)
    click('#submit-btn')
    await vi.waitFor(() => expect(apiMocks.submitTransaction).toHaveBeenCalledTimes(1))

    click('[data-view="recent"]')
    await vi.waitFor(() => expect(apiMocks.listTransactions).toHaveBeenCalledTimes(2))
    expect(document.querySelector('.transaction-row')?.textContent)
      .toContain('切換後晚餐')
  })
})

describe('visibility auth flow', () => {
  it('visibilitychange triggers auth-check and an expired session surfaces re-auth', async () => {
    mount()
    await vi.waitFor(() => expect(apiMocks.authCheck).toHaveBeenCalledTimes(1))
    apiMocks.authCheck.mockResolvedValueOnce({ ok: false })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    })

    document.dispatchEvent(new Event('visibilitychange'))

    await vi.waitFor(() => expect(apiMocks.authCheck).toHaveBeenCalledTimes(2))
    expect(document.querySelector('#reauth-prompt')?.textContent).toContain('登入已過期')
    expect(document.querySelector('#reauth-btn')).not.toBeNull()
  })
})
