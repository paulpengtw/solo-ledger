import { describe, expect, it } from 'vitest'
import { isValidUuid, validateTransaction } from '../functions/lib/validate'

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
