import { describe, expect, it } from 'vitest'
import {
  isValidUuid,
  validateTransaction,
  validateTransactionDateRange,
} from '../functions/lib/validate'
import * as ValidateModule from '../functions/lib/validate'

const valid = {
  type: '支出',
  amount: 260,
  date: '2026-07-26',
  time: '18:30',
  description: '晚餐',
  account: '現金',
  category: '餐飲',
  payee: '小吃店',
  currency: 'TWD',
} as const

describe('validateTransaction', () => {
  it.each(['支出', '收入', '轉帳'] as const)('accepts the structural type %s', type => {
    const result = validateTransaction({ ...valid, type })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.transaction.type).toBe(type)
  })

  it('rejects a type outside the closed enum with a named error', () => {
    expect(validateTransaction({ ...valid, type: '沖銷' })).toEqual({
      ok: false,
      error: 'invalid type',
    })
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, '260'])(
    'rejects invalid amount %s',
    amount => {
      expect(validateTransaction({ ...valid, amount })).toEqual({
        ok: false,
        error: 'invalid amount',
      })
    },
  )

  it('accepts a well-formed real calendar date', () => {
    expect(validateTransaction({ ...valid, date: '2024-02-29' }).ok).toBe(true)
  })

  it('rejects a malformed date', () => {
    expect(validateTransaction({ ...valid, date: '2026/07/26' })).toEqual({
      ok: false,
      error: 'invalid date',
    })
  })

  it.each(['2026-02-30', '2026-13-01'])(
    'rejects the impossible calendar date %s',
    date => {
      expect(validateTransaction({ ...valid, date })).toEqual({
        ok: false,
        error: 'invalid date',
      })
    },
  )

  it('accepts a valid time', () => {
    expect(validateTransaction({ ...valid, time: '23:59' }).ok).toBe(true)
  })

  it('accepts an absent time', () => {
    const { time: _time, ...withoutTime } = valid
    const result = validateTransaction(withoutTime)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.transaction).not.toHaveProperty('time')
  })

  it.each(['25:00', '12:60'])('rejects the impossible time %s', time => {
    expect(validateTransaction({ ...valid, time })).toEqual({
      ok: false,
      error: 'invalid time',
    })
  })

  it.each(['', '   '])('rejects empty description %j', description => {
    expect(validateTransaction({ ...valid, description })).toEqual({
      ok: false,
      error: 'missing description',
    })
  })

  it.each(['應收', '應付'] as const)('accepts the structural iou value %s', iou => {
    expect(validateTransaction({ ...valid, iou }).ok).toBe(true)
  })

  it.each(['應收', '應付'] as const)(
    'rejects iou %s when counterparty wire field is missing',
    iou => {
      const { payee: _wirePayee, ...withoutCounterparty } = valid

      expect(validateTransaction({ ...withoutCounterparty, iou })).toEqual({
        ok: false,
        error: 'missing payee',
      })
    },
  )

  it('rejects an iou value outside the closed enum', () => {
    expect(validateTransaction({ ...valid, iou: '已收' })).toEqual({
      ok: false,
      error: 'invalid iou',
    })
  })

  it.each(['account', 'toAccount', 'category', 'payee', 'currency'] as const)(
    'rejects an empty optional string for %s',
    field => {
      expect(validateTransaction({ ...valid, [field]: '   ' })).toEqual({
        ok: false,
        error: `invalid ${field}`,
      })
    },
  )

  it('accepts invented vocabulary values because vocabulary belongs to Code.gs', () => {
    const transaction = {
      ...valid,
      account: '巷口郵局',
      category: '天外飛來一筆',
      payee: '月球雜貨店',
      currency: '銀河幣',
    }

    expect(validateTransaction(transaction)).toEqual({
      ok: true,
      transaction,
    })
  })
})

describe('isValidUuid', () => {
  it('accepts a valid UUID shape', () => {
    expect(isValidUuid('3b241101-e2bb-4255-8caf-4136c566a962')).toBe(true)
  })

  it('rejects a non-UUID idempotency key', () => {
    expect(isValidUuid('not-a-uuid')).toBe(false)
  })
})

describe('validateReversal', () => {
  it('accepts only txn_id and a real calendar date', () => {
    const validateReversal = (
      ValidateModule as typeof ValidateModule & {
        validateReversal?: (input: unknown) => unknown
      }
    ).validateReversal
    expect(validateReversal).toBeTypeOf('function')
    if (!validateReversal) return

    expect(validateReversal({
      txn_id: 'original-1',
      date: '2024-02-29',
    })).toEqual({
      ok: true,
      reversal: {
        txn_id: 'original-1',
        date: '2024-02-29',
      },
    })
  })

  it.each([
    [{ txn_id: '', date: '2026-07-27' }, 'invalid txn_id'],
    [{ txn_id: 'original-1', date: '2026-02-30' }, 'invalid date'],
    [{ txn_id: 'original-1', date: '2026-07-27', currency: 'TWD' }, 'currency is not accepted'],
  ])('rejects an invalid reversal %#', (input, error) => {
    const validateReversal = (
      ValidateModule as typeof ValidateModule & {
        validateReversal?: (input: unknown) => unknown
      }
    ).validateReversal
    expect(validateReversal).toBeTypeOf('function')
    if (!validateReversal) return

    expect(validateReversal(input)).toEqual({ ok: false, error })
  })
})

describe('validateTransactionDateRange', () => {
  it('accepts an inclusive real-calendar range', () => {
    expect(validateTransactionDateRange({
      date_from: '2026-07-01',
      date_to: '2026-07-31',
    })).toEqual({
      ok: true,
      date_from: '2026-07-01',
      date_to: '2026-07-31',
    })
  })

  it.each([
    [{ date_from: '2026/07/01', date_to: '2026-07-31' }, 'invalid date_from'],
    [{ date_from: '2026-02-30', date_to: '2026-07-31' }, 'invalid date_from'],
    [{ date_from: '2026-07-01', date_to: 'July 31, 2026' }, 'invalid date_to'],
    [{ date_from: '2026-07-01', date_to: '2026-02-30' }, 'invalid date_to'],
  ])('rejects malformed or impossible range boundary %#', (input, error) => {
    expect(validateTransactionDateRange(input)).toEqual({ ok: false, error })
  })

  it('names date_from later than date_to distinctly', () => {
    expect(validateTransactionDateRange({
      date_from: '2026-08-01',
      date_to: '2026-07-31',
    })).toEqual({
      ok: false,
      error: 'date_from later than date_to',
    })
  })
})
