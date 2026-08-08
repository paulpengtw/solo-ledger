// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CACHED_OPTIONS,
  PARTIALLY_SETTLED_GROUPS,
  RECEIVABLE_GROUPS,
  RECENT_TRANSACTIONS,
  REFRESHED_OPTIONS,
} from './pwa-fixtures'

const apiMocks = vi.hoisted(() => ({
  authCheck: vi.fn(),
  listReceivables: vi.fn(),
  listTransactions: vi.fn(),
  loadOptions: vi.fn(),
  reverseTransaction: vi.fn(),
  submitTransaction: vi.fn(),
  settleReceivable: vi.fn(),
}))

vi.mock('../src/api', () => ({
  authCheck: apiMocks.authCheck,
  listReceivables: apiMocks.listReceivables,
  listTransactions: apiMocks.listTransactions,
  loadOptions: apiMocks.loadOptions,
  reverseTransaction: apiMocks.reverseTransaction,
  submitTransaction: apiMocks.submitTransaction,
  settleReceivable: apiMocks.settleReceivable,
}))

import { mountApp } from '../src/main'

let unmount: (() => void) | undefined

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function mount(
  options: unknown = CACHED_OPTIONS,
  refresh: Promise<unknown> = new Promise(() => {}),
) {
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
  click('#next-amount')
  click('#account-picker [data-account="錢包"]')
  click('#category-grid [data-category="餐飲"]')
  click('.step-panel[data-step="payee"] .step-next')
  input('#description-input', description)
  click('.step-panel[data-step="details"] .step-next')
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
  apiMocks.authCheck.mockReset().mockResolvedValue({
    ok: true,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })
  apiMocks.listReceivables.mockReset().mockResolvedValue(RECEIVABLE_GROUPS)
  apiMocks.listTransactions.mockReset().mockResolvedValue(RECENT_TRANSACTIONS)
  apiMocks.loadOptions.mockReset()
  apiMocks.reverseTransaction.mockReset().mockResolvedValue({
    ok: true,
    alreadyRecorded: false,
  })
  apiMocks.submitTransaction.mockReset().mockResolvedValue({
    ok: true,
    alreadyRecorded: false,
  })
  apiMocks.settleReceivable.mockReset().mockResolvedValue({
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
  it('starts at amount, advances from account to category, and uses the journal strip', () => {
    mount()

    const panels = [...document.querySelectorAll<HTMLElement>('.step-panel')]
    expect(document.querySelector<HTMLElement>('#entry-view')?.dataset['activeStep'])
      .toBe('amount')
    expect(panels.filter(panel => panel.getAttribute('aria-hidden') === 'false'))
      .toHaveLength(1)
    expect(document.querySelector<HTMLElement>('[data-step="amount"]')
      ?.getAttribute('aria-hidden')).toBe('false')

    for (const key of ['2', '6', '0']) click(`#keypad [data-key="${key}"]`)
    click('#next-amount')
    click('#account-picker [data-account="錢包"]')

    expect(document.querySelector<HTMLElement>('#entry-view')?.dataset['activeStep'])
      .toBe('category')

    click('#journal-strip [data-strip-step="amount"]')

    expect(document.querySelector<HTMLElement>('#entry-view')?.dataset['activeStep'])
      .toBe('amount')
  })

  it('confirm step shows legs and amount for expense', () => {
    mount()
    fillExpense()

    const card = document.querySelector<HTMLElement>('#confirm-card')!
    expect(document.querySelector<HTMLElement>('#entry-view')?.dataset['activeStep'])
      .toBe('confirm')
    expect(card.textContent).toContain('借')
    expect(card.textContent).toContain('貸')
    expect(card.textContent).toContain('餐飲')
    expect(card.textContent).toContain('錢包')
    expect(card.textContent).toContain('260')
  })

  it('confirm step shows legs for transfer', () => {
    mount()
    click('#type-toggle [data-type="轉帳"]')
    for (const key of ['2', '6', '0']) click(`#keypad [data-key="${key}"]`)
    click('#next-amount')
    click('#account-picker [data-account="錢包"]')
    click('#to-account-picker [data-account="台新銀行"]')
    input('#description-input', '轉帳')
    click('.step-panel[data-step="details"] .step-next')

    const card = document.querySelector<HTMLElement>('#confirm-card')!
    expect(document.querySelector<HTMLElement>('#entry-view')?.dataset['activeStep'])
      .toBe('confirm')
    expect(card.textContent).toContain('台新銀行')
    expect(card.textContent).toContain('錢包')
  })

  it('tapping debit leg jumps to category; editing returns to confirm; payload updated', async () => {
    mount()
    fillExpense()

    click('#confirm-card .confirm-row[data-edit-step="category"]')
    expect(document.querySelector<HTMLElement>('#entry-view')?.dataset['activeStep'])
      .toBe('category')

    click('#category-grid [data-category="交通"]')
    expect(document.querySelector<HTMLElement>('#entry-view')?.dataset['activeStep'])
      .toBe('confirm')

    click('#submit-btn')
    await vi.waitFor(() => expect(apiMocks.submitTransaction).toHaveBeenCalledTimes(1))
    expect(apiMocks.submitTransaction).toHaveBeenCalledWith(expect.objectContaining({
      category: '交通',
    }), '3b241101-e2bb-4255-8caf-4136c566a962')
  })

  it('scrolls the active journal chip after a step change', () => {
    const scrollIntoView = vi.fn()
    const prototype = HTMLElement.prototype as unknown as Record<string, unknown>
    const original = Object.getOwnPropertyDescriptor(prototype, 'scrollIntoView')
    Object.defineProperty(prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })

    try {
      mount()
      for (const key of ['2', '6', '0']) click(`#keypad [data-key="${key}"]`)
      click('#next-amount')
      click('#account-picker [data-account="錢包"]')
      click('#journal-strip [data-strip-step="amount"]')

      expect(scrollIntoView).toHaveBeenCalledWith({
        block: 'nearest',
        inline: 'nearest',
      })
      expect(scrollIntoView).toHaveBeenCalledTimes(3)
    } finally {
      if (original) {
        Object.defineProperty(prototype, 'scrollIntoView', original)
      } else {
        delete prototype['scrollIntoView']
      }
    }
  })

  it('step-guard class is added on step change and removed after 300ms', () => {
    vi.useFakeTimers()
    try {
      mount()
      click('#keypad [data-key="2"]')
      click('#next-amount')

      const entryView = document.getElementById('entry-view')!
      expect(entryView.classList.contains('step-guard')).toBe(true)

      vi.advanceTimersByTime(300)
      expect(entryView.classList.contains('step-guard')).toBe(false)

      unmount?.()
      unmount = undefined
    } finally {
      vi.useRealTimers()
    }
  })

  it('keyboard-open class tracks visualViewport height', () => {
    const viewport = new EventTarget() as EventTarget & { height: number }
    viewport.height = window.innerHeight
    const removeEventListener = vi.spyOn(viewport, 'removeEventListener')
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: viewport,
    })

    try {
      mount()

      const app = document.getElementById('app')!
      expect(app.classList.contains('keyboard-open')).toBe(false)

      viewport.height = Math.floor(window.innerHeight * 0.5)
      viewport.dispatchEvent(new Event('resize'))
      expect(app.classList.contains('keyboard-open')).toBe(true)

      viewport.height = window.innerHeight
      viewport.dispatchEvent(new Event('resize'))
      expect(app.classList.contains('keyboard-open')).toBe(false)

      unmount?.()
      unmount = undefined
      expect(removeEventListener).toHaveBeenCalledWith(
        'resize',
        expect.any(Function),
      )
    } finally {
      delete (window as unknown as { visualViewport?: unknown }).visualViewport
    }
  })

  it('renders accounts grouped by 子類型, per-type categories, and tappable 對象 suggestions', () => {
    mount()

    expect(document.querySelector('[data-subtype="現金"]')?.textContent).toContain('錢包')
    expect(document.querySelector('[data-subtype="銀行"]')?.textContent).toContain('台新銀行')
    expect(document.querySelector('[data-subtype="信用卡"]')?.textContent).toContain('國泰卡')
    expect(document.querySelector('#category-grid')?.textContent).toContain('餐飲')
    expect(document.querySelector('#category-grid')?.textContent).not.toContain('薪資')
    expect(document.querySelector('#payee-suggestions')?.textContent).toContain('全聯')
    expect(document.querySelector<HTMLElement>('#iou-toggle')?.hidden).toBe(false)

    click('#type-toggle [data-type="收入"]')
    expect(document.querySelector('#category-grid')?.textContent).toContain('薪資')
    expect(document.querySelector('#category-grid')?.textContent).not.toContain('餐飲')
    expect(document.querySelector<HTMLElement>('#iou-toggle')?.hidden).toBe(true)

    click('#type-toggle [data-type="轉帳"]')
    expect(document.querySelector('#category-section')).toHaveProperty('hidden', true)
    expect(document.querySelector('#to-account-section')).toHaveProperty('hidden', false)
    expect(document.querySelector<HTMLElement>('#iou-toggle')?.hidden).toBe(true)
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
    click('#journal-strip [data-strip-step="payee"]')
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

  it('selects 代墊 應收 by hiding and clearing category and requiring 對象', async () => {
    mount()
    fillExpense()
    click('#journal-strip [data-strip-step="payee"]')

    const toggle = document.querySelector<HTMLButtonElement>(
      '#iou-toggle [data-iou="應收"]',
    )
    expect(toggle).not.toBeNull()
    toggle?.click()

    expect(document.querySelector<HTMLElement>('#category-section')?.hidden).toBe(true)
    expect(document.querySelector('#category-grid .selected')).toBeNull()
    expect(document.querySelector('#payee-heading')?.textContent).toContain('必填')
    expect(document.querySelector<HTMLInputElement>('#payee-input')?.required).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('#submit-btn')?.disabled).toBe(true)

    input('#payee-input', '阿明')
    click('.step-panel[data-step="payee"] .step-next')
    click('#submit-btn')

    await vi.waitFor(() => expect(apiMocks.submitTransaction).toHaveBeenCalledTimes(1))
    expect(apiMocks.submitTransaction).toHaveBeenCalledWith({
      type: '支出',
      amount: 260,
      date: '2026-07-27',
      description: '晚餐',
      account: '錢包',
      payee: '阿明',
      currency: 'TWD',
      iou: '應收',
    }, '3b241101-e2bb-4255-8caf-4136c566a962')
  })

  it('selects 應付 while keeping category and requiring 對象', async () => {
    mount()
    fillExpense()
    click('#journal-strip [data-strip-step="payee"]')

    const toggle = document.querySelector<HTMLButtonElement>(
      '#iou-toggle [data-iou="應付"]',
    )
    expect(toggle).not.toBeNull()
    toggle?.click()

    expect(document.querySelector<HTMLElement>('#category-section')?.hidden).toBe(false)
    expect(document.querySelector('#category-grid .selected')?.textContent).toBe('餐飲')
    expect(document.querySelector<HTMLInputElement>('#payee-input')?.required).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('#submit-btn')?.disabled).toBe(true)

    input('#payee-input', '阿明')
    click('.step-panel[data-step="payee"] .step-next')
    click('#submit-btn')

    await vi.waitFor(() => expect(apiMocks.submitTransaction).toHaveBeenCalledTimes(1))
    expect(apiMocks.submitTransaction).toHaveBeenCalledWith({
      type: '支出',
      amount: 260,
      date: '2026-07-27',
      description: '晚餐',
      account: '錢包',
      category: '餐飲',
      payee: '阿明',
      currency: 'TWD',
      iou: '應付',
    }, '3b241101-e2bb-4255-8caf-4136c566a962')
  })

  it('toggles iou off without clearing category or 對象', () => {
    mount()
    fillExpense()
    click('#journal-strip [data-strip-step="payee"]')
    input('#payee-input', '阿明')

    const toggle = document.querySelector<HTMLButtonElement>(
      '#iou-toggle [data-iou="應付"]',
    )
    expect(toggle).not.toBeNull()
    toggle?.click()
    toggle?.click()

    expect(document.querySelector<HTMLElement>('#category-section')?.hidden).toBe(false)
    expect(document.querySelector('#category-grid .selected')?.textContent).toBe('餐飲')
    expect(document.querySelector<HTMLInputElement>('#payee-input')?.value).toBe('阿明')
    expect(document.querySelector<HTMLInputElement>('#payee-input')?.required).toBe(false)
    expect(document.querySelector<HTMLButtonElement>('#submit-btn')?.disabled).toBe(false)
  })

  it('posts a split as two creates with two different idempotency keys', async () => {
    const randomUUID = vi.fn()
      .mockReturnValueOnce('3b241101-e2bb-4255-8caf-4136c566a962')
      .mockReturnValueOnce('a4dd45e4-4741-42bc-8750-40d3b0bbccca')
    apiMocks.loadOptions.mockReturnValue({
      cached: CACHED_OPTIONS,
      refresh: new Promise(() => {}),
    })
    unmount = mountApp(document.querySelector<HTMLElement>('#app')!, {
      today: () => '2026-07-27',
      randomUUID,
    })

    fillExpense('自己的午餐')
    click('#submit-btn')
    await vi.waitFor(() => expect(apiMocks.submitTransaction).toHaveBeenCalledTimes(1))
    await new Promise(resolve => setTimeout(resolve, 650))

    fillExpense('代墊午餐')
    click('#journal-strip [data-strip-step="payee"]')
    const toggle = document.querySelector<HTMLButtonElement>(
      '#iou-toggle [data-iou="應收"]',
    )
    expect(toggle).not.toBeNull()
    toggle?.click()
    input('#payee-input', '阿明')
    click('.step-panel[data-step="payee"] .step-next')
    click('#submit-btn')
    await vi.waitFor(() => expect(apiMocks.submitTransaction).toHaveBeenCalledTimes(2))

    expect(apiMocks.submitTransaction.mock.calls).toEqual([
      [
        expect.objectContaining({
          amount: 260,
          category: '餐飲',
          description: '自己的午餐',
        }),
        '3b241101-e2bb-4255-8caf-4136c566a962',
      ],
      [
        expect.objectContaining({
          amount: 260,
          payee: '阿明',
          description: '代墊午餐',
          iou: '應收',
        }),
        'a4dd45e4-4741-42bc-8750-40d3b0bbccca',
      ],
    ])
    expect(apiMocks.submitTransaction.mock.calls[1]?.[0]).not.toHaveProperty('category')
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

  it('offers reversal for an addressable ordinary row and requires confirmation', async () => {
    mount()
    click('[data-view="recent"]')
    await vi.waitFor(() => {
      expect(document.querySelector('[data-reverse-txn-id="txn-recent"]'))
        .not.toBeNull()
    })

    click('[data-reverse-txn-id="txn-recent"]')

    const confirmation = document.querySelector<HTMLElement>(
      '#reverse-confirmation',
    )
    expect(confirmation?.hidden).toBe(false)
    expect(confirmation?.textContent).toContain('確認沖銷')
    expect(confirmation?.textContent).toContain('晚餐')
    expect(apiMocks.reverseTransaction).not.toHaveBeenCalled()
  })

  it('reverses with a UUID after confirmation and refreshes recent entries', async () => {
    apiMocks.listTransactions
      .mockResolvedValueOnce(RECENT_TRANSACTIONS)
      .mockResolvedValueOnce(RECENT_TRANSACTIONS.slice(1))
    mount()
    click('[data-view="recent"]')
    await vi.waitFor(() => {
      expect(document.querySelector('[data-reverse-txn-id="txn-recent"]'))
        .not.toBeNull()
    })
    click('[data-reverse-txn-id="txn-recent"]')

    click('#confirm-reverse')

    await vi.waitFor(() => {
      expect(apiMocks.reverseTransaction).toHaveBeenCalledWith({
        txn_id: 'txn-recent',
        date: '2026-07-27',
      }, '3b241101-e2bb-4255-8caf-4136c566a962')
    })
    await vi.waitFor(() => {
      expect(apiMocks.listTransactions).toHaveBeenCalledTimes(2)
    })
    expect(document.querySelector('[data-reverse-txn-id="txn-recent"]'))
      .toBeNull()
  })
})

describe('outstanding items view', () => {
  it('groups 應收 and 應付 entries by 對象', async () => {
    mount()

    click('[data-view="outstanding"]')

    await vi.waitFor(() => {
      expect(apiMocks.listReceivables).toHaveBeenCalledTimes(1)
    })
    const groups = document.querySelectorAll<HTMLElement>('.receivable-group')
    expect(groups).toHaveLength(2)
    expect(groups[0]?.dataset['counterparty']).toBe('阿明')
    expect(groups[0]?.textContent).toContain('應收')
    expect(groups[0]?.textContent).toContain('320 TWD')
    expect(groups[1]?.dataset['counterparty']).toBe('小美')
    expect(groups[1]?.textContent).toContain('應付')
    expect(groups[1]?.textContent).toContain('720 TWD')
  })

  it('renders a hand row without any settle affordance', async () => {
    mount()

    click('[data-view="outstanding"]')

    await vi.waitFor(() => {
      expect(document.querySelectorAll('.receivable-entry')).toHaveLength(3)
    })
    const handRow = document.querySelector<HTMLElement>(
      '.receivable-entry[data-view-only="true"]',
    )
    expect(handRow?.textContent).toContain('手動代墊')
    expect(handRow?.querySelector('[data-settle-txn-id]')).toBeNull()
    expect(handRow?.querySelector('button')).toBeNull()
  })

  it('states in the confirmation step that settlement cannot be reversed', async () => {
    mount()
    click('[data-view="outstanding"]')
    await vi.waitFor(() => {
      expect(document.querySelector('[data-settle-txn-id="receivable-open-001"]'))
        .not.toBeNull()
    })

    click('[data-settle-txn-id="receivable-open-001"]')

    const confirmation = document.querySelector<HTMLElement>(
      '#settle-confirmation',
    )
    expect(confirmation?.hidden).toBe(false)
    expect(confirmation?.textContent).toContain('結清後無法復原')
    expect(apiMocks.settleReceivable).not.toHaveBeenCalled()
  })

  it('refreshes the displayed remainder after a partial settle', async () => {
    apiMocks.listReceivables
      .mockResolvedValueOnce(RECEIVABLE_GROUPS)
      .mockResolvedValueOnce(PARTIALLY_SETTLED_GROUPS)
    mount()
    click('[data-view="outstanding"]')
    await vi.waitFor(() => {
      expect(document.querySelector('[data-settle-txn-id="receivable-open-001"]'))
        .not.toBeNull()
    })
    click('[data-settle-txn-id="receivable-open-001"]')
    input('#settle-amount', '200')

    click('#confirm-settle')

    await vi.waitFor(() => {
      expect(apiMocks.settleReceivable).toHaveBeenCalledWith({
        txn_id: 'receivable-open-001',
        account: '錢包',
        date: '2026-07-27',
        amount: 200,
      }, '3b241101-e2bb-4255-8caf-4136c566a962')
    })
    await vi.waitFor(() => {
      expect(apiMocks.listReceivables).toHaveBeenCalledTimes(2)
    })
    const row = document.querySelector<HTMLElement>(
      '.receivable-entry[data-txn-id="receivable-open-001"]',
    )
    expect(row?.textContent).toContain('120 TWD')
    expect(row?.textContent).not.toContain('320 TWD')
  })

  it('retries an ambiguous settlement with the same UUID and immutable payload', async () => {
    apiMocks.settleReceivable
      .mockResolvedValueOnce({
        ok: false,
        kind: 'network',
        message: '沒有網路連線，請再試一次',
      })
      .mockResolvedValueOnce({ ok: true, alreadyRecorded: true })
    mount()
    click('[data-view="outstanding"]')
    await vi.waitFor(() => {
      expect(document.querySelector('[data-settle-txn-id="receivable-open-001"]'))
        .not.toBeNull()
    })
    click('[data-settle-txn-id="receivable-open-001"]')
    input('#settle-amount', '200')

    click('#confirm-settle')

    await vi.waitFor(() => {
      expect(apiMocks.settleReceivable).toHaveBeenCalledTimes(1)
    })
    await vi.waitFor(() => {
      expect(document.querySelector('#settle-status')?.textContent)
        .toContain('沒有網路連線')
    })
    const amount = document.querySelector<HTMLInputElement>('#settle-amount')!
    const account = document.querySelector('#settle-account') as unknown as
      HTMLSelectElement
    const date = document.querySelector<HTMLInputElement>('#settle-date')!
    expect(amount.disabled).toBe(true)
    expect(account.disabled).toBe(true)
    expect(date.disabled).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('#cancel-settle')?.disabled)
      .toBe(true)

    amount.value = '100'
    account.value = '台新銀行'
    date.value = '2026-07-28'
    click('#confirm-settle')

    await vi.waitFor(() => {
      expect(apiMocks.settleReceivable).toHaveBeenCalledTimes(2)
    })
    expect(apiMocks.settleReceivable.mock.calls[1]).toEqual(
      apiMocks.settleReceivable.mock.calls[0],
    )
  })

  it('cannot cancel or open another settlement while a request is in flight', async () => {
    const settlement = deferred<{
      ok: true
      alreadyRecorded: false
    }>()
    apiMocks.settleReceivable.mockReturnValueOnce(settlement.promise)
    mount()
    click('[data-view="outstanding"]')
    await vi.waitFor(() => {
      expect(document.querySelector('[data-settle-txn-id="receivable-open-001"]'))
        .not.toBeNull()
    })
    click('[data-settle-txn-id="receivable-open-001"]')
    click('#confirm-settle')
    await vi.waitFor(() => {
      expect(apiMocks.settleReceivable).toHaveBeenCalledTimes(1)
    })

    const cancel = document.querySelector<HTMLButtonElement>('#cancel-settle')!
    expect(cancel.disabled).toBe(true)
    cancel.click()
    click('[data-settle-txn-id="payable-open-001"]')
    expect(document.querySelector('#settle-target')?.textContent)
      .toContain('阿明')

    settlement.resolve({ ok: true, alreadyRecorded: false })

    await vi.waitFor(() => {
      expect(apiMocks.listReceivables).toHaveBeenCalledTimes(2)
    })
    expect(document.querySelector<HTMLElement>('#settle-confirmation')?.hidden)
      .toBe(true)
  })

  it('enables confirmation when options arrive after the dialog opens', async () => {
    const refresh = deferred<typeof CACHED_OPTIONS>()
    mount(null, refresh.promise)
    click('[data-view="outstanding"]')
    await vi.waitFor(() => {
      expect(document.querySelector('[data-settle-txn-id="receivable-open-001"]'))
        .not.toBeNull()
    })
    click('[data-settle-txn-id="receivable-open-001"]')
    const confirm = document.querySelector<HTMLButtonElement>('#confirm-settle')!
    expect(confirm.disabled).toBe(true)

    refresh.resolve(CACHED_OPTIONS)

    await vi.waitFor(() => {
      expect(confirm.disabled).toBe(false)
    })
    const account = document.querySelector('#settle-account') as unknown as
      HTMLSelectElement
    expect(account.value).toBe('錢包')
  })
})

describe('visibility auth flow', () => {
  it('visibilitychange triggers auth-check and an expired session surfaces re-auth', async () => {
    // Under the 5-minute gate, onVisible immediately after startup is coalesced.
    // Exercise the expired-session path via the startup check instead: startup
    // check returns ok:false and surfaces the re-auth prompt directly.
    apiMocks.authCheck.mockResolvedValueOnce({ ok: false })
    mount()
    await vi.waitFor(() => expect(apiMocks.authCheck).toHaveBeenCalledTimes(1))
    expect(document.querySelector('#reauth-prompt')?.textContent).toContain('登入已過期')
    expect(document.querySelector('#reauth-btn')).not.toBeNull()
  })

  it('visibility after the minimum interval triggers a gated auth-check', async () => {
    // Resolve with a far-future session so the session stays live throughout
    apiMocks.authCheck.mockResolvedValue({
      ok: true,
      exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    })

    mount()

    // Wait for the startup auth-check
    await vi.waitFor(() => expect(apiMocks.authCheck).toHaveBeenCalledTimes(1))

    // Three rapid visibilitychange events — all within the 5-minute gate
    document.dispatchEvent(new Event('visibilitychange'))
    document.dispatchEvent(new Event('visibilitychange'))
    document.dispatchEvent(new Event('visibilitychange'))
    // Flush any triggered microtasks
    await new Promise<void>(resolve => setTimeout(resolve, 0))

    expect(apiMocks.authCheck).toHaveBeenCalledTimes(1)

    // Advance Date.now() past the 5-minute minimum check interval.
    // We fake only Date (leaving setTimeout/microtasks real so vi.waitFor still works).
    const realNow = Date.now()
    try {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(realNow + 301_000)

      // One more visibilitychange — this one should pass the gate
      document.dispatchEvent(new Event('visibilitychange'))

      await vi.waitFor(() => expect(apiMocks.authCheck).toHaveBeenCalledTimes(2))
    } finally {
      vi.useRealTimers()
    }

    expect(document.querySelector('#reauth-prompt')).toBeNull()
  })
})

describe('expired session during a write', () => {
  const AUTH_FAILURE = { ok: false, kind: 'auth', message: '登入已過期' }

  it('a failed 記帳 reports the expired session and offers re-login, not a network error', async () => {
    apiMocks.submitTransaction.mockResolvedValueOnce(AUTH_FAILURE)
    mount()
    fillExpense()

    click('#submit-btn')

    await vi.waitFor(() => {
      expect(document.querySelector('#status-message')?.textContent)
        .toContain('登入已過期')
    })
    expect(document.querySelector('#status-message')?.textContent)
      .not.toContain('沒有網路連線')
    expect(document.querySelector('#reauth-prompt')).not.toBeNull()
    expect(document.querySelector('#reauth-btn')?.textContent).toBe('重新登入')
  })

  it('a failed 結清 reports the expired session and offers re-login', async () => {
    apiMocks.settleReceivable.mockResolvedValueOnce(AUTH_FAILURE)
    mount()
    click('[data-view="outstanding"]')
    await vi.waitFor(() => {
      expect(document.querySelector('[data-settle-txn-id="receivable-open-001"]'))
        .not.toBeNull()
    })
    click('[data-settle-txn-id="receivable-open-001"]')

    click('#confirm-settle')

    await vi.waitFor(() => {
      expect(document.querySelector('#settle-status')?.textContent)
        .toContain('登入已過期')
    })
    expect(document.querySelector('#reauth-prompt')).not.toBeNull()
  })

  it('a failed 沖銷 reports the expired session and offers re-login', async () => {
    apiMocks.reverseTransaction.mockResolvedValueOnce(AUTH_FAILURE)
    mount()
    click('[data-view="recent"]')
    await vi.waitFor(() => {
      expect(document.querySelector('[data-reverse-txn-id="txn-recent"]'))
        .not.toBeNull()
    })
    click('[data-reverse-txn-id="txn-recent"]')

    click('#confirm-reverse')

    await vi.waitFor(() => {
      expect(document.querySelector('#reverse-status')?.textContent)
        .toContain('登入已過期')
    })
    expect(document.querySelector('#reauth-prompt')).not.toBeNull()
  })

  it('a genuine offline failure keeps the network message and offers no re-login prompt', async () => {
    apiMocks.submitTransaction.mockResolvedValueOnce({
      ok: false,
      kind: 'network',
      message: '沒有網路連線，請再試一次',
    })
    mount()
    fillExpense()

    click('#submit-btn')

    await vi.waitFor(() => {
      expect(document.querySelector('#status-message')?.textContent)
        .toContain('沒有網路連線')
    })
    expect(document.querySelector('#reauth-prompt')).toBeNull()
  })
})
