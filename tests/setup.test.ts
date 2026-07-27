import { beforeEach, describe, expect, it } from 'vitest'
import {
  loadGasFunctionsWithFakeGas,
  type FakeGasHarness,
  type FakeSheet,
} from './helpers/gas'

const expectedJournalHeaders = [
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

const expectedTabNames = ['日記帳', '會計科目', '選項清單', '設定', '餘額', '試算與檢查']

describe('setupSpreadsheet', () => {
  let harness: FakeGasHarness

  beforeEach(() => {
    harness = loadGasFunctionsWithFakeGas()
  })

  it('creates all six required tabs on a blank spreadsheet', () => {
    harness.setupSpreadsheet()

    expect(harness.spreadsheet.getSheets().map((sheet) => sheet.getName())).toEqual(expectedTabNames)
  })

  it('writes exactly the 15 required journal headers in spec order', () => {
    harness.setupSpreadsheet()

    expect(rowValues(requiredSheet(harness, '日記帳'), 1)).toEqual(expectedJournalHeaders)
  })

  it('formats 日期, 時間, and 建立時間 journal columns as text', () => {
    harness.setupSpreadsheet()
    const journal = requiredSheet(harness, '日記帳')

    expect(journal.getRange(1, 1).getNumberFormats()[0]![0]).toBe('@')
    expect(journal.getRange(1, 2).getNumberFormats()[0]![0]).toBe('@')
    expect(journal.getRange(1, 15).getNumberFormats()[0]![0]).toBe('@')
  })

  it('seeds the required system accounts with their accounting types', () => {
    harness.setupSpreadsheet()
    const accounts = tableRows(requiredSheet(harness, '會計科目'))
    const typeByName = Object.fromEntries(accounts.slice(1).map((row) => [row[0], row[1]]))

    expect(typeByName).toMatchObject({
      期初餘額: '權益',
      應收帳款: '資產',
      應付帳款: '負債',
      調整支出: '支出',
      調整收入: '收入',
    })
  })

  it('seeds TWD and a default account that names a seeded asset account', () => {
    harness.setupSpreadsheet()
    const accountRows = tableRows(requiredSheet(harness, '會計科目')).slice(1)
    const settingsRows = tableRows(requiredSheet(harness, '設定')).slice(1)
    const settings = Object.fromEntries(settingsRows.map((row) => [row[0], row[1]]))
    const seededAssetNames = accountRows
      .filter((row) => row[1] === '資產')
      .map((row) => row[0])

    expect(settings.預設幣別).toBe('TWD')
    expect(seededAssetNames).toContain(settings.預設帳戶)
  })

  it('installs COA-fed dropdown validation on both journal account columns', () => {
    harness.setupSpreadsheet()
    const journal = requiredSheet(harness, '日記帳')

    for (const column of [4, 5]) {
      const validation = journal.getRange(2, column).getDataValidations()[0]![0]
      expect(validation).not.toBeNull()
      expect(validation?.criteriaType).toBe('VALUE_IN_RANGE')
      expect(validation?.range.getSheet().getName()).toBe('會計科目')
      expect(validation?.range.getRow()).toBe(2)
      expect(validation?.range.getColumn()).toBe(1)
    }
  })

  it('is idempotent when run twice', () => {
    harness.setupSpreadsheet()
    const firstTabNames = harness.spreadsheet.getSheets().map((sheet) => sheet.getName())
    const firstJournalHeaders = rowValues(requiredSheet(harness, '日記帳'), 1)
    const firstAccountRows = tableRows(requiredSheet(harness, '會計科目'))
    const firstSettingsRows = tableRows(requiredSheet(harness, '設定'))

    harness.setupSpreadsheet()

    expect(harness.spreadsheet.getSheets().map((sheet) => sheet.getName())).toEqual(firstTabNames)
    expect(rowValues(requiredSheet(harness, '日記帳'), 1)).toEqual(firstJournalHeaders)
    expect(tableRows(requiredSheet(harness, '會計科目'))).toEqual(firstAccountRows)
    expect(tableRows(requiredSheet(harness, '設定'))).toEqual(firstSettingsRows)
  })

  it('does not clobber user-entered accounts, option values, or settings', () => {
    harness.setupSpreadsheet()
    const accounts = requiredSheet(harness, '會計科目')
    const options = requiredSheet(harness, '選項清單')
    const settings = requiredSheet(harness, '設定')
    const userAccount = ['信用合作社', '資產', '銀行', true, 999]

    accounts.getRange(accounts.getLastRow() + 1, 1, 1, 5).setValues([userAccount])
    options.getRange(2, 1).setValues([['巷口商店']])
    settings.getRange(2, 2).setValues([['USD']])

    harness.setupSpreadsheet()

    expect(tableRows(accounts)).toContainEqual(userAccount)
    expect(options.getRange(2, 1).getValues()[0]![0]).toBe('巷口商店')
    expect(settings.getRange(2, 2).getValues()[0]![0]).toBe('USD')
  })

  it('produces a journal header row accepted by resolveHeaders_', () => {
    harness.setupSpreadsheet()
    const bootstrappedHeaders = rowValues(requiredSheet(harness, '日記帳'), 1)

    expect(harness.resolveHeaders_(bootstrappedHeaders, expectedJournalHeaders)).toEqual({
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
    })
  })
})

function requiredSheet(harness: FakeGasHarness, name: string): FakeSheet {
  const sheet = harness.spreadsheet.getSheetByName(name)
  if (!sheet) {
    throw new Error(`missing test sheet: ${name}`)
  }
  return sheet
}

function rowValues(sheet: FakeSheet, row: number): unknown[] {
  const lastColumn = sheet.getLastColumn()
  return lastColumn === 0 ? [] : sheet.getRange(row, 1, 1, lastColumn).getValues()[0]!
}

function tableRows(sheet: FakeSheet): unknown[][] {
  const lastRow = sheet.getLastRow()
  const lastColumn = sheet.getLastColumn()
  return lastRow === 0 || lastColumn === 0
    ? []
    : sheet.getRange(1, 1, lastRow, lastColumn).getValues()
}
