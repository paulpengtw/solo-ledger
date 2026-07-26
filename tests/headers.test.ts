import { describe, expect, it } from 'vitest'
import { loadGasFunctions } from './helpers/gas'

const { JOURNAL_HEADERS, resolveHeaders_ } = loadGasFunctions()

const canonicalHeaderRow = [
  '日期',
  '時間',
  '類型',
  '借方帳戶',
  '貸方帳戶',
  '金額',
  '幣別',
  '分類',
  '對象',
  '說明',
  '結清狀態',
  '沖銷txn_id',
  'txn_id',
  '來源',
  '建立時間',
]

const canonicalResolution = {
  日期: 1,
  時間: 2,
  類型: 3,
  借方帳戶: 4,
  貸方帳戶: 5,
  金額: 6,
  幣別: 7,
  分類: 8,
  對象: 9,
  說明: 10,
  結清狀態: 11,
  沖銷txn_id: 12,
  txn_id: 13,
  來源: 14,
  建立時間: 15,
}

describe('resolveHeaders_', () => {
  it('resolves every canonical journal header to its 1-based column index', () => {
    expect(JOURNAL_HEADERS).toEqual(canonicalHeaderRow)
    expect(resolveHeaders_(canonicalHeaderRow, JOURNAL_HEADERS)).toEqual(canonicalResolution)
  })

  it('resolves every required header after the columns are reordered', () => {
    const reordered = [
      'txn_id',
      '金額',
      '日期',
      '貸方帳戶',
      '說明',
      '來源',
      '類型',
      '時間',
      '建立時間',
      '對象',
      '借方帳戶',
      '沖銷txn_id',
      '分類',
      '幣別',
      '結清狀態',
    ]

    expect(resolveHeaders_(reordered, canonicalHeaderRow)).toEqual({
      日期: 3,
      時間: 8,
      類型: 7,
      借方帳戶: 11,
      貸方帳戶: 4,
      金額: 2,
      幣別: 14,
      分類: 13,
      對象: 10,
      說明: 5,
      結清狀態: 15,
      沖銷txn_id: 12,
      txn_id: 1,
      來源: 6,
      建立時間: 9,
    })
  })

  it('ignores extra columns inserted at the start, middle, and end', () => {
    const withExtras = [
      '收據',
      '日期',
      '時間',
      '類型',
      '借方帳戶',
      '貸方帳戶',
      '匯率',
      '金額',
      '幣別',
      '分類',
      '對象',
      '說明',
      '結清狀態',
      '沖銷txn_id',
      'txn_id',
      '來源',
      '建立時間',
      '備註',
      '',
      '   ',
    ]

    expect(resolveHeaders_(withExtras, canonicalHeaderRow)).toEqual({
      日期: 2,
      時間: 3,
      類型: 4,
      借方帳戶: 5,
      貸方帳戶: 6,
      金額: 8,
      幣別: 9,
      分類: 10,
      對象: 11,
      說明: 12,
      結清狀態: 13,
      沖銷txn_id: 14,
      txn_id: 15,
      來源: 16,
      建立時間: 17,
    })
  })

  it('does not change required-header resolution when an extra column is renamed', () => {
    const before = ['自訂欄位', ...canonicalHeaderRow]
    const after = ['重新命名的自訂欄位', ...canonicalHeaderRow]

    expect(resolveHeaders_(after, canonicalHeaderRow)).toEqual(
      resolveHeaders_(before, canonicalHeaderRow),
    )
  })

  it('ignores repeated extra headers that share names with Object prototype properties', () => {
    const withPrototypeNamedExtras = ['constructor', 'toString', ...canonicalHeaderRow, 'constructor']

    expect(resolveHeaders_(withPrototypeNamedExtras, canonicalHeaderRow)).toMatchObject({
      日期: 3,
      時間: 4,
      建立時間: 17,
    })
  })

  it.each(canonicalHeaderRow)('throws an error naming a missing required header: %s', (missingHeader) => {
    const withoutHeader = canonicalHeaderRow.filter((header) => header !== missingHeader)

    expect(() => resolveHeaders_(withoutHeader, canonicalHeaderRow)).toThrow(
      new RegExp(missingHeader),
    )
  })

  it('names every missing required header in one error', () => {
    const missingHeaders = ['借方帳戶', '幣別', '建立時間']
    const incomplete = canonicalHeaderRow.filter((header) => !missingHeaders.includes(header))

    let thrown: unknown
    try {
      resolveHeaders_(incomplete, canonicalHeaderRow)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    for (const missingHeader of missingHeaders) {
      expect((thrown as Error).message).toContain(missingHeader)
    }
  })

  it('throws an error naming a duplicated required header', () => {
    const duplicated = [...canonicalHeaderRow]
    duplicated.splice(5, 0, '借方帳戶')

    expect(() => resolveHeaders_(duplicated, canonicalHeaderRow)).toThrow(
      /duplicate required header: 借方帳戶/,
    )
  })

  it('trims surrounding whitespace from header cells before matching', () => {
    const padded = canonicalHeaderRow.map((header) => ` \t${header}\n `)

    expect(resolveHeaders_(padded, canonicalHeaderRow)).toEqual(canonicalResolution)
  })
})
