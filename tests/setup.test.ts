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
  '交易對象',
  '說明',
  '結清狀態',
  '沖銷txn_id',
  'txn_id',
  '來源',
  '建立時間',
  'source_observation_id',
]

const expectedTabNames = ['日記帳', '會計科目', '選項清單', '設定', '餘額', '試算與檢查']
const expectedCheckLabels = [
  '試算平衡',
  '未知帳戶',
  '結清狀態與衍生餘額',
  '非文字日期/時間',
]

describe('setupSpreadsheet', () => {
  let harness: FakeGasHarness

  beforeEach(() => {
    harness = loadGasFunctionsWithFakeGas()
  })

  it('creates all six required tabs on a blank spreadsheet', () => {
    harness.setupSpreadsheet()

    expect(harness.spreadsheet.getSheets().map((sheet) => sheet.getName())).toEqual(expectedTabNames)
  })

  it('writes the required journal headers plus additive observation identity metadata', () => {
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

  it('installs formula rows on both formula-only tabs', () => {
    harness.setupSpreadsheet()
    const balances = requiredSheet(harness, '餘額')
    const checks = requiredSheet(harness, '試算與檢查')

    for (const formula of [
      balances.getRange(2, 1).getValues()[0]![0],
      balances.getRange(2, 2).getValues()[0]![0],
      balances.getRange(2, 3).getValues()[0]![0],
      checks.getRange(2, 2).getValues()[0]![0],
      checks.getRange(3, 2).getValues()[0]![0],
      checks.getRange(4, 2).getValues()[0]![0],
      checks.getRange(5, 2).getValues()[0]![0],
    ]) {
      expect(formula).toEqual(expect.any(String))
      expect(formula as string).toMatch(/^=/)
    }
  })

  it('locates every referenced journal column by matching its header name', () => {
    harness.setupSpreadsheet()
    const formulaTabs = [
      requiredSheet(harness, '餘額'),
      requiredSheet(harness, '試算與檢查'),
    ]
    const journalFormulas = formulaTabs
      .flatMap((sheet) => tableRows(sheet).flat())
      .filter((value): value is string => typeof value === 'string' && value.includes("'日記帳'!"))

    expect(journalFormulas.length).toBeGreaterThan(0)
    for (const formula of journalFormulas) {
      const journalIndexes = formula.match(/INDEX\('日記帳'!/g) || []
      const namedHeaderMatches =
        formula.match(
          /MATCH\("(日期|時間|類型|借方帳戶|貸方帳戶|金額|結清狀態|沖銷txn_id|txn_id)",'日記帳'!\$1:\$1,0\)/g,
        ) || []

      expect(namedHeaderMatches).toHaveLength(journalIndexes.length)
      expect(formula).not.toMatch(/'日記帳'!\$?[A-Z]+/)
    }

    const allJournalFormulas = journalFormulas.join('\n')
    for (const header of [
      '日期',
      '時間',
      '類型',
      '借方帳戶',
      '貸方帳戶',
      '金額',
      '結清狀態',
      '沖銷txn_id',
      'txn_id',
    ]) {
      expect(allJournalFormulas).toContain(`MATCH("${header}"`)
    }
  })

  it('creates exactly one balance row per seeded account', () => {
    harness.setupSpreadsheet()
    const accountCount = requiredSheet(harness, '會計科目').getLastRow() - 1
    const balanceCount = requiredSheet(harness, '餘額').getLastRow() - 1

    expect(balanceCount).toBe(accountCount)
  })

  it('makes asset balances debit-positive and liability balances credit-positive', () => {
    harness.setupSpreadsheet()
    const accounts = requiredSheet(harness, '會計科目')
    const balances = requiredSheet(harness, '餘額')
    const accountRows = tableRows(accounts)
    const assetSheetRow = accountRows.findIndex((row) => row[1] === '資產') + 1
    const liabilitySheetRow = accountRows.findIndex((row) => row[1] === '負債') + 1
    const assetFormula = balances.getRange(assetSheetRow, 3).getValues()[0]![0]
    const liabilityFormula = balances.getRange(liabilitySheetRow, 3).getValues()[0]![0]

    expect(assetFormula).toEqual(expect.any(String))
    expect(liabilityFormula).toEqual(expect.any(String))
    expect(assetFormula as string).toMatch(
      new RegExp(`^=IF\\(OR\\(\\$B${assetSheetRow}="資產",\\$B${assetSheetRow}="支出"\\),`),
    )
    expect(liabilityFormula as string).toMatch(
      new RegExp(
        `^=IF\\(OR\\(\\$B${liabilitySheetRow}="負債",\\$B${liabilitySheetRow}="收入",\\$B${liabilitySheetRow}="權益"\\),`,
      ),
    )
    expect(firstMatchedAccountHeader(assetFormula as string)).toBe('借方帳戶')
    expect(firstMatchedAccountHeader(liabilityFormula as string)).toBe('貸方帳戶')
  })

  it('labels all four always-on audit checks', () => {
    harness.setupSpreadsheet()
    const checks = tableRows(requiredSheet(harness, '試算與檢查'))

    expect(checks.slice(1).map((row) => row[0])).toEqual(expectedCheckLabels)
    for (const formula of checks.slice(1).map((row) => row[1])) {
      expect(formula).toEqual(expect.any(String))
      expect(formula as string).toContain('"OK"')
      expect(formula as string).toContain('"異常：')
    }
  })

  it('excludes blank statuses from the status-vs-derived cross-check', () => {
    harness.setupSpreadsheet()
    const checks = tableRows(requiredSheet(harness, '試算與檢查'))
    const statusCheck = checks.find((row) => row[0] === '結清狀態與衍生餘額')
    const formula = statusCheck?.[1]

    expect(formula).toEqual(expect.any(String))
    expect(formula as string).toContain('IF(status="",0,')
  })

  it('is idempotent when run twice', () => {
    harness.setupSpreadsheet()
    const firstTabNames = harness.spreadsheet.getSheets().map((sheet) => sheet.getName())
    const firstJournalHeaders = rowValues(requiredSheet(harness, '日記帳'), 1)
    const firstAccountRows = tableRows(requiredSheet(harness, '會計科目'))
    const firstSettingsRows = tableRows(requiredSheet(harness, '設定'))
    const firstBalanceRows = tableRows(requiredSheet(harness, '餘額'))
    const firstCheckRows = tableRows(requiredSheet(harness, '試算與檢查'))

    harness.setupSpreadsheet()

    expect(harness.spreadsheet.getSheets().map((sheet) => sheet.getName())).toEqual(firstTabNames)
    expect(rowValues(requiredSheet(harness, '日記帳'), 1)).toEqual(firstJournalHeaders)
    expect(tableRows(requiredSheet(harness, '會計科目'))).toEqual(firstAccountRows)
    expect(tableRows(requiredSheet(harness, '設定'))).toEqual(firstSettingsRows)
    expect(tableRows(requiredSheet(harness, '餘額'))).toEqual(firstBalanceRows)
    expect(tableRows(requiredSheet(harness, '試算與檢查'))).toEqual(firstCheckRows)
  })

  it('extends balance formulas when setup reruns after a hand-added account', () => {
    harness.setupSpreadsheet()
    const accounts = requiredSheet(harness, '會計科目')
    const balances = requiredSheet(harness, '餘額')
    const firstBalanceFormula = balances.getRange(2, 3).getValues()[0]![0]
    const accountRow = accounts.getLastRow() + 1

    accounts.getRange(accountRow, 1, 1, 5).setValues([
      ['信用合作社', '資產', '銀行', true, 999],
    ])

    expect(balances.getLastRow()).toBe(accountRow - 1)

    harness.setupSpreadsheet()

    expect(balances.getLastRow()).toBe(accountRow)
    expect(balances.getRange(accountRow, 1).getValues()[0]![0]).toContain(
      "INDEX('會計科目'!$1:$1000,ROW(),MATCH(\"名稱\"",
    )
    expect(balances.getRange(accountRow, 2).getValues()[0]![0]).toContain(
      "INDEX('會計科目'!$1:$1000,ROW(),MATCH(\"類型\"",
    )
    expect(balances.getRange(accountRow, 3).getValues()[0]![0]).toContain(
      `$A${accountRow}`,
    )
    expect(balances.getRange(2, 3).getValues()[0]![0]).toBe(firstBalanceFormula)
  })

  it('does not clobber user-entered accounts, option values, settings, or formula-tab cells', () => {
    harness.setupSpreadsheet()
    const accounts = requiredSheet(harness, '會計科目')
    const options = requiredSheet(harness, '選項清單')
    const settings = requiredSheet(harness, '設定')
    const balances = requiredSheet(harness, '餘額')
    const checks = requiredSheet(harness, '試算與檢查')
    const userAccount = ['信用合作社', '資產', '銀行', true, 999]

    accounts.getRange(accounts.getLastRow() + 1, 1, 1, 5).setValues([userAccount])
    options.getRange(2, 1).setValues([['巷口商店']])
    settings.getRange(2, 2).setValues([['USD']])
    balances.getRange(2, 3).setValues([['=USER_BALANCE_FORMULA()']])
    checks.getRange(2, 2).setValues([['=USER_CHECK_FORMULA()']])

    harness.setupSpreadsheet()

    expect(tableRows(accounts)).toContainEqual(userAccount)
    expect(options.getRange(2, 1).getValues()[0]![0]).toBe('巷口商店')
    expect(settings.getRange(2, 2).getValues()[0]![0]).toBe('USD')
    expect(balances.getRange(2, 3).getValues()[0]![0]).toBe('=USER_BALANCE_FORMULA()')
    expect(checks.getRange(2, 2).getValues()[0]![0]).toBe('=USER_CHECK_FORMULA()')
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
      交易對象: 9,
      說明: 10,
      結清狀態: 11,
      沖銷txn_id: 12,
      txn_id: 13,
      來源: 14,
      建立時間: 15,
      source_observation_id: 16,
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
    : sheet.getRange(1, 1, lastRow, lastColumn).getValues().map(row =>
      sheet.getName() === '會計科目' ? row.slice(0, 5) : row,
    )
}

function firstMatchedAccountHeader(formula: string): string | undefined {
  return formula.match(/MATCH\("(借方帳戶|貸方帳戶)"/)?.[1]
}
