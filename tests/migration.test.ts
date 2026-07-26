import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadGasFunctionsWithFakeGas,
  type FakeGasHarness,
  type FakeSheet,
  type FakeSpreadsheet,
} from './helpers/gas'

const fixedNow = new Date('2026-07-27T00:00:00.000Z')
const migrationNow = '2026-07-27T08:00:00.000+08:00'

const journalHeaders = [
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
] as const

type JournalRow = Record<(typeof journalHeaders)[number], unknown>

describe('closeAndOpenBooks', () => {
  let harness: FakeGasHarness
  let oldRows: JournalRow[]

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(fixedNow)
    harness = loadGasFunctionsWithFakeGas()

    harness.setScriptProperty('LEDGER_SPREADSHEET_ID', harness.oldSpreadsheetId)
    harness.setupSpreadsheet()
    addAccount(harness.oldSpreadsheet, ['國泰卡', '負債', '信用卡', true, 130])
    oldRows = oldJournalFixture()
    appendJournalRows(harness.oldSpreadsheet, oldRows)

    harness.setScriptProperty('LEDGER_SPREADSHEET_ID', harness.spreadsheetId)
    harness.setupSpreadsheet()
    addAccount(harness.spreadsheet, ['國泰卡', '負債', '信用卡', true, 130])
    harness.clearEvents()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes full asset and mirrored liability openings from old journal arithmetic and skips zero balances', () => {
    harness.closeAndOpenBooks(harness.oldSpreadsheetId)

    const migrated = journalRows(harness.spreadsheet)
    const ordinaryOpenings = migrated.filter(row => row['結清狀態'] === '')

    expect(accountBalance(oldRows, '現金', '資產')).toBe(400)
    expect(accountBalance(oldRows, '銀行', '資產')).toBe(750)
    expect(accountBalance(oldRows, '國泰卡', '負債')).toBe(600)
    expect(accountBalance(oldRows, '悠遊卡', '資產')).toBe(0)
    expect(ordinaryOpenings).toEqual([
      {
        日期: '2026-07-27',
        時間: '',
        類型: '轉帳',
        借方帳戶: '現金',
        貸方帳戶: '期初餘額',
        金額: 400,
        幣別: 'TWD',
        分類: '',
        對象: '',
        說明: '',
        結清狀態: '',
        沖銷txn_id: '',
        txn_id: '00000000-0000-4000-8000-000000000001',
        來源: '移轉',
        建立時間: migrationNow,
      },
      {
        日期: '2026-07-27',
        時間: '',
        類型: '轉帳',
        借方帳戶: '銀行',
        貸方帳戶: '期初餘額',
        金額: 750,
        幣別: 'TWD',
        分類: '',
        對象: '',
        說明: '',
        結清狀態: '',
        沖銷txn_id: '',
        txn_id: '00000000-0000-4000-8000-000000000002',
        來源: '移轉',
        建立時間: migrationNow,
      },
      {
        日期: '2026-07-27',
        時間: '',
        類型: '轉帳',
        借方帳戶: '期初餘額',
        貸方帳戶: '國泰卡',
        金額: 600,
        幣別: 'TWD',
        分類: '',
        對象: '',
        說明: '',
        結清狀態: '',
        沖銷txn_id: '',
        txn_id: '00000000-0000-4000-8000-000000000003',
        來源: '移轉',
        建立時間: migrationNow,
      },
    ])
    expect(migrated.some(row =>
      row['借方帳戶'] === '悠遊卡' || row['貸方帳戶'] === '悠遊卡',
    )).toBe(false)
  })

  it('carries only still-open receivables and payables at their remaining outstanding with fresh identities', () => {
    const oldTxnIds = new Set(oldRows.map(row => String(row.txn_id)))

    harness.closeAndOpenBooks(harness.oldSpreadsheetId)

    const migrated = journalRows(harness.spreadsheet)
    const carried = migrated.filter(row => row['結清狀態'] === '未結')

    expect(carried).toEqual([
      {
        日期: '2026-07-27',
        時間: '',
        類型: '轉帳',
        借方帳戶: '應收帳款',
        貸方帳戶: '期初餘額',
        金額: 350,
        幣別: 'TWD',
        分類: '',
        對象: '阿明',
        說明: '承前-代買車票',
        結清狀態: '未結',
        沖銷txn_id: '',
        txn_id: '00000000-0000-4000-8000-000000000004',
        來源: '移轉',
        建立時間: migrationNow,
      },
      {
        日期: '2026-07-27',
        時間: '',
        類型: '轉帳',
        借方帳戶: '期初餘額',
        貸方帳戶: '應付帳款',
        金額: 520,
        幣別: 'TWD',
        分類: '',
        對象: '小美',
        說明: '承前-朋友先付',
        結清狀態: '未結',
        沖銷txn_id: '',
        txn_id: '00000000-0000-4000-8000-000000000005',
        來源: '移轉',
        建立時間: migrationNow,
      },
    ])
    expect(carried[0]?.['金額']).not.toBe(500)
    expect(carried[1]?.['金額']).not.toBe(720)
    expect(carried.every(row => !oldTxnIds.has(String(row.txn_id)))).toBe(true)
    expect(migrated).toHaveLength(5)
    expect(migrated.every(row => row['沖銷txn_id'] === '')).toBe(true)
    expect(migrated.map(row => row['說明'])).not.toContain('承前-已結代墊')
    expect(migrated.map(row => row['說明'])).not.toContain('承前-已沖銷代墊')
  })

  it('leaves every old sheet value, format, and validation byte-for-byte unchanged', () => {
    const before = spreadsheetBytes(harness.oldSpreadsheet)

    harness.closeAndOpenBooks(harness.oldSpreadsheetId)

    expect(spreadsheetBytes(harness.oldSpreadsheet)).toBe(before)
  })

  it('produces a clean audited new book with preserved real-account balances and a balanced trial balance', () => {
    harness.closeAndOpenBooks(harness.oldSpreadsheetId)

    const migrated = journalRows(harness.spreadsheet)
    const report = harness.checkConsistency_({ repair: false }) as {
      clean: boolean
      rules: Record<string, { clean: boolean; offenses: unknown[] }>
    }
    const totalDebits = migrated.reduce(
      (sum, row) => sum + (row['借方帳戶'] === '' ? 0 : Number(row['金額'])),
      0,
    )
    const totalCredits = migrated.reduce(
      (sum, row) => sum + (row['貸方帳戶'] === '' ? 0 : Number(row['金額'])),
      0,
    )

    expect(report.clean).toBe(true)
    expect(Object.values(report.rules).every(rule =>
      rule.clean && rule.offenses.length === 0,
    )).toBe(true)
    expect(totalDebits).toBe(2620)
    expect(totalCredits).toBe(2620)
    expect(newBookBalance(migrated, '現金', '資產')).toBe(400)
    expect(newBookBalance(migrated, '銀行', '資產')).toBe(750)
    expect(newBookBalance(migrated, '應收帳款', '資產')).toBe(350)
    expect(newBookBalance(migrated, '國泰卡', '負債')).toBe(600)
    expect(newBookBalance(migrated, '應付帳款', '負債')).toBe(520)
  })

  it('guards the fresh target so a second run cannot double-post', () => {
    harness.closeAndOpenBooks(harness.oldSpreadsheetId)
    const once = journalBytes(harness.spreadsheet)

    expect(() =>
      harness.closeAndOpenBooks(harness.oldSpreadsheetId),
    ).toThrowError('new book journal must be empty before migration')
    expect(journalBytes(harness.spreadsheet)).toBe(once)
  })
})

function oldJournalFixture(): JournalRow[] {
  return [
    journalRow({
      類型: '收入',
      借方帳戶: '銀行',
      貸方帳戶: '薪資收入',
      金額: 2000,
      分類: '薪資收入',
      說明: '薪資',
      txn_id: 'income-001',
    }),
    transfer('fund-cash-001', '現金', '銀行', 1000),
    journalRow({
      借方帳戶: '應收帳款',
      貸方帳戶: '現金',
      金額: 500,
      對象: '阿明',
      說明: '代買車票',
      結清狀態: '部分',
      txn_id: 'receivable-open-001',
    }),
    settlement('settle-receivable-a', '銀行', '應收帳款', 100, 'receivable-open-001'),
    settlement('settle-receivable-b', '銀行', '應收帳款', 50, 'receivable-open-001'),
    journalRow({
      借方帳戶: '餐飲',
      貸方帳戶: '應付帳款',
      金額: 720,
      分類: '餐飲',
      對象: '小美',
      說明: '朋友先付',
      結清狀態: '部分',
      txn_id: 'payable-open-001',
    }),
    settlement('settle-payable', '應付帳款', '銀行', 200, 'payable-open-001'),
    journalRow({
      借方帳戶: '應收帳款',
      貸方帳戶: '現金',
      金額: 100,
      對象: '已結對象',
      說明: '已結代墊',
      結清狀態: '已結',
      txn_id: 'receivable-closed-001',
    }),
    settlement('settle-closed', '銀行', '應收帳款', 100, 'receivable-closed-001'),
    journalRow({
      借方帳戶: '應收帳款',
      貸方帳戶: '現金',
      金額: 60,
      對象: '沖銷對象',
      說明: '已沖銷代墊',
      結清狀態: '已沖銷',
      txn_id: 'receivable-reversed-001',
    }),
    journalRow({
      日期: '2026-07-27',
      時間: '',
      類型: '沖銷',
      借方帳戶: '現金',
      貸方帳戶: '應收帳款',
      金額: 60,
      對象: '',
      說明: '',
      沖銷txn_id: 'receivable-reversed-001',
      txn_id: 'reverse-receivable-001',
    }),
    journalRow({
      借方帳戶: '餐飲',
      貸方帳戶: '國泰卡',
      金額: 900,
      分類: '餐飲',
      說明: '刷卡',
      txn_id: 'card-expense-001',
    }),
    transfer('card-payment-001', '國泰卡', '銀行', 300),
    transfer('easycard-load-001', '悠遊卡', '銀行', 50),
    transfer('easycard-unload-001', '銀行', '悠遊卡', 50),
  ]
}

function journalRow(overrides: Partial<JournalRow>): JournalRow {
  return {
    日期: '2026-07-26',
    時間: '12:30',
    類型: '支出',
    借方帳戶: '餐飲',
    貸方帳戶: '現金',
    金額: 100,
    幣別: 'TWD',
    分類: '',
    對象: '',
    說明: '',
    結清狀態: '',
    沖銷txn_id: '',
    txn_id: '',
    來源: 'pwa',
    建立時間: '2026-07-26T12:30:00+08:00',
    ...overrides,
  }
}

function transfer(
  txnId: string,
  debitAccount: string,
  creditAccount: string,
  amount: number,
): JournalRow {
  return journalRow({
    類型: '轉帳',
    借方帳戶: debitAccount,
    貸方帳戶: creditAccount,
    金額: amount,
    txn_id: txnId,
  })
}

function settlement(
  txnId: string,
  debitAccount: string,
  creditAccount: string,
  amount: number,
  originalTxnId: string,
): JournalRow {
  return journalRow({
    類型: '轉帳',
    借方帳戶: debitAccount,
    貸方帳戶: creditAccount,
    金額: amount,
    沖銷txn_id: originalTxnId,
    txn_id: txnId,
  })
}

function addAccount(
  spreadsheet: FakeSpreadsheet,
  account: unknown[],
): void {
  const accounts = requiredSheet(spreadsheet, '會計科目')
  accounts
    .getRange(accounts.getLastRow() + 1, 1, 1, account.length)
    .setValues([account])
}

function appendJournalRows(
  spreadsheet: FakeSpreadsheet,
  rows: JournalRow[],
): void {
  const journal = requiredSheet(spreadsheet, '日記帳')
  journal
    .getRange(
      journal.getLastRow() + 1,
      1,
      rows.length,
      journalHeaders.length,
    )
    .setValues(rows.map(row => journalHeaders.map(header => row[header])))
}

function journalRows(spreadsheet: FakeSpreadsheet): JournalRow[] {
  const journal = requiredSheet(spreadsheet, '日記帳')
  if (journal.getLastRow() < 2) return []
  const headers = journal
    .getRange(1, 1, 1, journal.getLastColumn())
    .getValues()[0]!
    .map(String)
  return journal
    .getRange(2, 1, journal.getLastRow() - 1, journal.getLastColumn())
    .getValues()
    .map(values =>
      Object.fromEntries(
        headers.map((header, index) => [header, values[index]]),
      ) as JournalRow,
    )
}

function journalBytes(spreadsheet: FakeSpreadsheet): string {
  const journal = requiredSheet(spreadsheet, '日記帳')
  return JSON.stringify(
    journal
      .getRange(1, 1, journal.getLastRow(), journal.getLastColumn())
      .getValues(),
  )
}

function spreadsheetBytes(spreadsheet: FakeSpreadsheet): string {
  return JSON.stringify(
    spreadsheet.getSheets().map(sheet => {
      const lastRow = sheet.getLastRow()
      const lastColumn = sheet.getLastColumn()
      const rows = Math.max(1, sheet.getMaxRows())
      const columns = Math.max(1, lastColumn)
      return {
        name: sheet.getName(),
        values: lastRow === 0 || lastColumn === 0
          ? []
          : sheet.getRange(1, 1, lastRow, lastColumn).getValues(),
        formats: sheet.getRange(1, 1, rows, columns).getNumberFormats(),
        validations: sheet
          .getRange(1, 1, rows, columns)
          .getDataValidations()
          .map(validationRow => validationRow.map(validation =>
            validation
              ? {
                  criteriaType: validation.criteriaType,
                  sourceSheet: validation.range.getSheet().getName(),
                  sourceRow: validation.range.getRow(),
                  sourceColumn: validation.range.getColumn(),
                  sourceRows: validation.range.getNumRows(),
                  sourceColumns: validation.range.getNumColumns(),
                  showDropdown: validation.showDropdown,
                  allowInvalid: validation.allowInvalid,
                }
              : null,
          )),
      }
    }),
  )
}

function accountBalance(
  rows: JournalRow[],
  account: string,
  type: '資產' | '負債',
): number {
  return newBookBalance(rows, account, type)
}

function newBookBalance(
  rows: JournalRow[],
  account: string,
  type: '資產' | '負債',
): number {
  const debitTotal = rows.reduce(
    (sum, row) =>
      sum + (row['借方帳戶'] === account ? Number(row['金額']) : 0),
    0,
  )
  const creditTotal = rows.reduce(
    (sum, row) =>
      sum + (row['貸方帳戶'] === account ? Number(row['金額']) : 0),
    0,
  )
  return type === '資產'
    ? debitTotal - creditTotal
    : creditTotal - debitTotal
}

function requiredSheet(
  spreadsheet: FakeSpreadsheet,
  name: string,
): FakeSheet {
  const sheet = spreadsheet.getSheetByName(name)
  if (!sheet) throw new Error(`missing test sheet: ${name}`)
  return sheet
}
