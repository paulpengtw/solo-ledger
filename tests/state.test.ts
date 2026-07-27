import { describe, expect, it } from 'vitest'
import {
  beginSubmit,
  buildTransaction,
  canSubmit,
  initialState,
  pressKey,
  selectAccount,
  selectCategory,
  selectToAccount,
  setDescription,
  setPayee,
  setType,
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
  it('clears a stale category and payee when 支出 changes to 轉帳', () => {
    let state = setPayee(filledExpense(), '全聯')

    state = setType(state, '轉帳')

    expect(state.category).toBeNull()
    expect(state.payee).toBe('')
  })

  it('clears a stale toAccount when 轉帳 changes to 支出', () => {
    let state = setType(initialState('2026-07-27'), '轉帳')
    state = selectToAccount(state, '台新銀行')

    state = setType(state, '支出')

    expect(state.toAccount).toBeNull()
  })
})

describe('submit gating and payload construction', () => {
  it('blocks submit when the required 說明 is empty or whitespace', () => {
    expect(canSubmit(setDescription(filledExpense(), ''))).toBe(false)
    expect(canSubmit(setDescription(filledExpense(), ' \n\t '))).toBe(false)
  })

  it('builds an expense transaction with a numeric amount and no rejected toAccount', () => {
    const transaction = buildTransaction(setPayee(filledExpense(), '全聯'))

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

  it('builds a transfer transaction without rejected category or payee fields', () => {
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
})

describe('retry state', () => {
  it('reuses the first idempotency key after a failed submission', () => {
    let state = beginSubmit(filledExpense(), () => 'uuid-1')
    state = submitFailed(state, 'timeout')
    state = beginSubmit(state, () => 'uuid-2')

    expect(state.idempotencyKey).toBe('uuid-1')
  })
})
