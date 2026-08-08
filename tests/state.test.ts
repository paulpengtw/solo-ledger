import { describe, expect, it } from 'vitest'
import {
  beginSubmit,
  buildTransaction,
  canSubmit,
  goBack,
  goNext,
  jumpFromConfirm,
  initialState,
  jumpTo,
  pressKey,
  postingLegs,
  resetForNext,
  selectAccount,
  selectCategory,
  selectToAccount,
  setDescription,
  setIou,
  setCounterparty,
  setType,
  stepSequence,
  submitFailed,
  type FormState,
} from '../src/state'

function filledExpense(): FormState {
  let state = initialState('2026-07-27')
  for (const key of ['2', '6', '0']) state = pressKey(state, key)
  state = selectAccount(state, '錢包')
  state = selectCategory(state, '餐飲')
  state = setDescription(state, '晚餐')
  return state
}

describe('per-type field guards', () => {
  it('clears a stale category and counterparty when 支出 changes to 轉帳', () => {
    let state = setCounterparty(filledExpense(), '全聯')

    state = setType(state, '轉帳')

    expect(state.category).toBeNull()
    expect(state.counterparty).toBe('')
  })

  it('clears a stale toAccount when 轉帳 changes to 支出', () => {
    let state = setType(initialState('2026-07-27'), '轉帳')
    state = selectToAccount(state, '台新銀行')

    state = setType(state, '支出')

    expect(state.toAccount).toBeNull()
  })

  it.each(['收入', '轉帳'] as const)(
    'clears iou when 支出 changes to %s',
    type => {
      let state = setIou(filledExpense(), '應付')

      state = setType(state, type)

      expect(state.iou).toBeNull()
    },
  )
})

describe('entry steps', () => {
  it.each([
    ['支出', ['amount', 'account', 'category', 'counterparty', 'details', 'confirm']],
    ['收入', ['amount', 'account', 'category', 'counterparty', 'details', 'confirm']],
    ['轉帳', ['amount', 'account', 'toAccount', 'details', 'confirm']],
  ] as const)('derives the %s step sequence', (type, expected) => {
    const state = setType(initialState('2026-07-27'), type)

    expect(stepSequence(state)).toEqual(expected)
  })

  it('omits category for a 支出 with 應收', () => {
    const state = setIou(initialState('2026-07-27'), '應收')

    expect(stepSequence(state)).toEqual([
      'amount',
      'account',
      'counterparty',
      'details',
      'confirm',
    ])
  })

  it('clamps next and back navigation at both ends', () => {
    const initial = initialState('2026-07-27')
    const confirm = jumpTo(initial, 'confirm')

    expect(goBack(initial)).toEqual(initial)
    expect(goNext(confirm)).toEqual(confirm)
    expect(goNext(jumpTo(initial, 'account')).step).toBe('category')
    expect(goBack(jumpTo(initial, 'account')).step).toBe('amount')
  })

  it('preserves submission state while navigating', () => {
    const state: FormState = {
      ...jumpTo(initialState('2026-07-27'), 'account'),
      status: 'error',
      errorMessage: '連線失敗',
      idempotencyKey: 'uuid-1',
    }

    expect(goNext(state)).toMatchObject({
      step: 'category',
      status: 'error',
      errorMessage: '連線失敗',
      idempotencyKey: 'uuid-1',
    })
  })

  it('ignores a jump to a step outside the current sequence', () => {
    const state = setType(initialState('2026-07-27'), '轉帳')

    expect(jumpTo(state, 'category')).toEqual(state)
  })

  it('falls back to amount when changing type invalidates category', () => {
    const state = jumpTo(initialState('2026-07-27'), 'category')

    expect(setType(state, '轉帳').step).toBe('amount')
  })

  it('resets the next entry at the amount step', () => {
    const state = jumpTo(
      setType(initialState('2026-07-27'), '轉帳'),
      'toAccount',
    )

    const reset = resetForNext(state, '2026-07-28')
    expect(reset.step).toBe('amount')
    expect(reset.returnToConfirm).toBe(false)
  })

  it('returns to confirm after a valid edit and keeps the flag through invalid edits', () => {
    const confirm = jumpTo(filledExpense(), 'confirm')
    const editing = jumpFromConfirm(confirm, 'category')

    expect(editing).toMatchObject({
      step: 'category',
      returnToConfirm: true,
    })
    expect(goNext(editing)).toMatchObject({
      step: 'confirm',
      returnToConfirm: false,
    })

    const invalid = setDescription(editing, '   ')
    expect(goNext(invalid)).toMatchObject({
      step: 'counterparty',
      returnToConfirm: true,
    })
    expect(goBack(invalid).returnToConfirm).toBe(true)
  })
})

describe('posting legs', () => {
  it('maps each transaction type and IOU mode to debit and credit legs', () => {
    const expense = filledExpense()
    const income = setType(expense, '收入')
    const transfer = selectToAccount(setType(expense, '轉帳'), '台新銀行')
    const receivable = setCounterparty(setIou(expense, '應收'), '阿明')
    const payable = setCounterparty(setIou(expense, '應付'), '阿明')

    expect(postingLegs(expense)).toEqual({
      debit: '餐飲',
      credit: '錢包',
    })
    expect(postingLegs(income)).toEqual({
      debit: '錢包',
      credit: '餐飲',
    })
    expect(postingLegs(transfer)).toEqual({
      debit: '台新銀行',
      credit: '錢包',
    })
    expect(postingLegs(receivable)).toEqual({
      debit: '應收帳款',
      credit: '錢包',
    })
    expect(postingLegs(payable)).toEqual({
      debit: '餐飲',
      credit: '應付帳款',
    })
  })
})

describe('submit gating and payload construction', () => {
  it('blocks submit when the required 說明 is empty or whitespace', () => {
    expect(canSubmit(setDescription(filledExpense(), ''))).toBe(false)
    expect(canSubmit(setDescription(filledExpense(), ' \n\t '))).toBe(false)
  })

  it('builds an expense transaction with a numeric amount and no rejected toAccount', () => {
    const transaction = buildTransaction(setCounterparty(filledExpense(), '全聯'))

    expect(transaction).toEqual({
      type: '支出',
      amount: 260,
      date: '2026-07-27',
      description: '晚餐',
      account: '錢包',
      category: '餐飲',
      payee: '全聯',
      currency: 'TWD',
    })
    expect(typeof transaction.amount).toBe('number')
    expect(transaction.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(transaction).not.toHaveProperty('toAccount')
  })

  it('builds a transfer transaction without rejected category or counterparty fields', () => {
    let state = setType(filledExpense(), '轉帳')
    state = selectToAccount(state, '台新銀行')

    const transaction = buildTransaction(state)

    expect(transaction).toEqual({
      type: '轉帳',
      amount: 260,
      date: '2026-07-27',
      description: '晚餐',
      account: '錢包',
      toAccount: '台新銀行',
      currency: 'TWD',
    })
    expect(transaction).not.toHaveProperty('category')
    expect(transaction).not.toHaveProperty('payee')
  })

  it('selects iou 應收 by clearing category and requiring counterparty', () => {
    let state = setIou(filledExpense(), '應收')

    expect(state.category).toBeNull()
    expect(state.iou).toBe('應收')
    expect(canSubmit(state)).toBe(false)

    state = setCounterparty(state, '阿明')

    expect(canSubmit(state)).toBe(true)
    expect(buildTransaction(state)).toEqual({
      type: '支出',
      amount: 260,
      date: '2026-07-27',
      description: '晚餐',
      account: '錢包',
      payee: '阿明',
      currency: 'TWD',
      iou: '應收',
    })
  })

  it('selects iou 應付 by preserving and requiring category and counterparty', () => {
    let state = setIou(filledExpense(), '應付')

    expect(state.category).toBe('餐飲')
    expect(canSubmit(state)).toBe(false)

    state = setCounterparty(state, '阿明')
    expect(canSubmit(state)).toBe(true)
    expect(canSubmit({ ...state, category: null })).toBe(false)
  })

  it('toggles iou off without clearing category or counterparty still used by a normal expense', () => {
    let state = setCounterparty(filledExpense(), '阿明')
    state = setIou(state, '應付')

    state = setIou(state, '應付')

    expect(state.iou).toBeNull()
    expect(state.category).toBe('餐飲')
    expect(state.counterparty).toBe('阿明')
  })
})

describe('retry state', () => {
  it('reuses the first idempotency key after a failed submission', () => {
    let state = beginSubmit(filledExpense(), () => 'uuid-1')
    state = submitFailed(state, 'timeout')
    state = beginSubmit(state, () => 'uuid-2')

    expect(state.idempotencyKey).toBe('uuid-1')
  })
})
