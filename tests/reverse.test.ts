import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildEnvelope as productionBuildEnvelope } from '../functions/lib/envelope'
import { CONTRACT_VERSION } from '../src/generated/version'
import {
  loadGasFunctionsWithFakeGas,
  type FakeGasHarness,
  type FakeSheet,
  type FakeTextOutput,
} from './helpers/gas'

const buildEnvelope = (secret: string, payload: Record<string, unknown>, ts: number, nonce: string) =>
  productionBuildEnvelope(secret, { ...payload, contractVersion: CONTRACT_VERSION }, ts, nonce)

const secret = 'test-secret'
const fixedNow = new Date('2026-07-27T00:00:00.000Z')

const journalHeaders = [
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
]

describe('reverse_transaction', () => {
  let harness: FakeGasHarness

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(fixedNow)
    harness = loadGasFunctionsWithFakeGas()
    harness.setupSpreadsheet()
    harness.clearEvents()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reverses an ordinary 支出 with a complete swapped mirror stamped in the default currency', async () => {
    setDefaultCurrency(harness, 'JPY')
    appendJournalRows(harness, [
      ordinaryExpense('expense-001', { 幣別: 'USD' }),
    ])

    const response = await postReverse(harness, 'reverse-expense-001', {
      txn_id: 'expense-001',
    })

    expect(response).toEqual({
      ok: true,
      txn_id: 'reverse-expense-001',
      row: 3,
    })
    expect(journalRows(harness)[1]).toEqual({
      日期: '2026-07-27',
      時間: '',
      類型: '沖銷',
      借方帳戶: '現金',
      貸方帳戶: '餐飲',
      金額: 260,
      幣別: 'JPY',
      分類: '餐飲',
      交易對象: '',
      說明: '',
      結清狀態: '',
      沖銷txn_id: 'expense-001',
      txn_id: 'reverse-expense-001',
      來源: 'pwa',
      建立時間: '2026-07-27T08:00:00.000+08:00',
    })
  })

  it.each([
    [
      '收入',
      ordinaryIncome('income-001'),
      'income-001',
      { 借方帳戶: '薪資收入', 貸方帳戶: '銀行', 分類: '薪資收入' },
    ],
    [
      '轉帳',
      ordinaryTransfer('transfer-001'),
      'transfer-001',
      { 借方帳戶: '現金', 貸方帳戶: '銀行', 分類: '' },
    ],
  ])('reverses an ordinary %s with swapped legs', async (_type, original, txnId, expected) => {
    appendJournalRows(harness, [original])

    const response = await postReverse(harness, `reverse-${txnId}`, {
      txn_id: txnId,
    })

    expect(response.ok).toBe(true)
    expect(journalRows(harness)[1]).toMatchObject({
      類型: '沖銷',
      金額: original.金額,
      沖銷txn_id: txnId,
      ...expected,
    })
  })

  it('rejects a settlement target by name without writing', async () => {
    appendJournalRows(harness, [
      settlement('settlement-001', 'receivable-001', 100),
    ])
    const before = journalBytes(harness)

    const response = await postReverse(harness, 'reverse-settlement-001', {
      txn_id: 'settlement-001',
    })

    expect(response).toEqual({
      ok: false,
      error: 'cannot reverse settlement row: settlement-001',
    })
    expect(journalBytes(harness)).toBe(before)
  })

  it('rejects a reversal target by name without writing', async () => {
    appendJournalRows(harness, [
      reversal('existing-reversal-001', 'expense-001'),
    ])
    const before = journalBytes(harness)

    const response = await postReverse(harness, 'reverse-reversal-001', {
      txn_id: 'existing-reversal-001',
    })

    expect(response).toEqual({
      ok: false,
      error: 'cannot reverse reversal row: existing-reversal-001',
    })
    expect(journalBytes(harness)).toBe(before)
  })

  it('rejects an original that already has settlements without changing its status', async () => {
    appendJournalRows(harness, [
      receivable('settled-original-001', '部分'),
      settlement('prior-settlement-001', 'settled-original-001', 40),
    ])
    const before = journalBytes(harness)

    const response = await postReverse(harness, 'reverse-settled-original-001', {
      txn_id: 'settled-original-001',
    })

    expect(response).toEqual({
      ok: false,
      error: 'cannot reverse transaction with settlements: settled-original-001',
    })
    expect(journalBytes(harness)).toBe(before)
    expect(journalRows(harness)[0]?.結清狀態).toBe('部分')
  })

  it.each(['未結', '部分'])(
    'sets an original with status %s to 已沖銷',
    async status => {
      const txnId = `open-${status}`
      appendJournalRows(harness, [receivable(txnId, status)])

      await postReverse(harness, `reverse-${status}`, { txn_id: txnId })

      expect(journalRows(harness)[0]?.結清狀態).toBe('已沖銷')
    },
  )

  it('removes an open original from list_receivables after reversal', async () => {
    appendJournalRows(harness, [receivable('open-list-001', '未結')])
    expect(await postListReceivables(harness)).toHaveLength(1)

    await postReverse(harness, 'reverse-open-list-001', {
      txn_id: 'open-list-001',
    })

    expect(await postListReceivables(harness)).toEqual([])
  })

  it('uses a reversal row in the journal as the durable idempotency backstop with an empty cache', async () => {
    appendJournalRows(harness, [
      ordinaryExpense('journal-backstop-original-001'),
      reversal('prior-reversal-001', 'journal-backstop-original-001'),
    ])
    const before = journalBytes(harness)
    expect(harness.peekCache('nonce:replay-reversal-001')).toBeNull()

    const response = await postReverse(harness, 'replay-reversal-001', {
      txn_id: 'journal-backstop-original-001',
    })

    expect(response).toEqual({ ok: true, txn_id: 'prior-reversal-001', row: 3, already: true })
    expect(journalBytes(harness)).toBe(before)
    expect(journalRows(harness).filter(row =>
      row.類型 === '沖銷'
      && row.沖銷txn_id === 'journal-backstop-original-001',
    )).toHaveLength(1)
  })

  it('refuses a reversal key reused for another target after cache expiry', async () => {
    appendJournalRows(harness, [
      ordinaryExpense('reverse-key-first'),
      ordinaryExpense('reverse-key-second'),
    ])
    await postReverse(harness, 'reverse-key-used', { txn_id: 'reverse-key-first' })
    harness.advanceCacheTime(601)
    const before = journalBytes(harness)

    const response = await postReverse(harness, 'reverse-key-used', {
      txn_id: 'reverse-key-second',
    })

    expect(response).toEqual({
      ok: false,
      error: 'idempotency key already used for another reversal',
    })
    expect(journalBytes(harness)).toBe(before)
    const replay = await postReverse(harness, 'reverse-key-used', { txn_id: 'reverse-key-first' })
    expect(replay).toEqual({ ok: true, txn_id: 'reverse-key-used', row: 4, already: true })
    expect(journalBytes(harness)).toBe(before)
  })

  it('refuses a reversal when the script lock cannot be acquired', async () => {
    appendJournalRows(harness, [ordinaryExpense('lock-original')])
    const before = journalBytes(harness)
    harness.failNextLock()
    const response = await postReverse(harness, 'lock-reversal', { txn_id: 'lock-original' })
    expect(response).toEqual({ ok: false, error: 'simulated lock failure' })
    expect(journalBytes(harness)).toBe(before)
  })

  it('fully exempts derived legs from 啟用 checks', async () => {
    setAccountEnabled(harness, '現金', false)
    setAccountEnabled(harness, '餐飲', false)
    appendJournalRows(harness, [ordinaryExpense('disabled-legs-001')])

    const response = await postReverse(harness, 'reverse-disabled-legs-001', {
      txn_id: 'disabled-legs-001',
    })

    expect(response.ok).toBe(true)
    expect(journalRows(harness)[1]).toMatchObject({
      借方帳戶: '現金',
      貸方帳戶: '餐飲',
    })
  })

  it('rejects a currency request field without writing', async () => {
    appendJournalRows(harness, [ordinaryExpense('request-currency-001')])
    const before = journalBytes(harness)

    const response = await postReverse(harness, 'reverse-request-currency-001', {
      txn_id: 'request-currency-001',
      currency: 'USD',
    })

    expect(response).toEqual({ ok: false, error: 'currency is rejected' })
    expect(journalBytes(harness)).toBe(before)
  })

  it('writes the mirror row before the status cell and commits the nonce last', async () => {
    appendJournalRows(harness, [receivable('write-order-001', '未結')])
    harness.clearEvents()

    await postReverse(harness, 'reverse-write-order-001', {
      txn_id: 'write-order-001',
    })

    expect(harness.events).toEqual([
      'lock-acquired',
      'nonce-checked',
      'row-written',
      'status-written',
      'nonce-committed',
      'lock-released',
    ])
  })

  it('arithmetically zeroes the net effect of both legs for the original and mirror pair', async () => {
    appendJournalRows(harness, [ordinaryExpense('zero-net-001')])

    await postReverse(harness, 'reverse-zero-net-001', {
      txn_id: 'zero-net-001',
    })

    const pair = journalRows(harness)
    const netByAccount = new Map<string, number>()
    for (const row of pair) {
      const amount = Number(row.金額)
      const debit = String(row.借方帳戶)
      const credit = String(row.貸方帳戶)
      netByAccount.set(debit, (netByAccount.get(debit) ?? 0) + amount)
      netByAccount.set(credit, (netByAccount.get(credit) ?? 0) - amount)
    }

    expect(Object.fromEntries(netByAccount)).toEqual({
      餐飲: 0,
      現金: 0,
    })
  })
})

type JsonResponse = Record<string, unknown>
type JournalRow = Record<string, unknown>

function ordinaryExpense(
  txnId: string,
  overrides: JournalRow = {},
): JournalRow {
  return {
    日期: '2026-07-26',
    時間: '18:30',
    類型: '支出',
    借方帳戶: '餐飲',
    貸方帳戶: '現金',
    金額: 260,
    幣別: 'TWD',
    分類: '餐飲',
    交易對象: '全聯',
    說明: '晚餐',
    結清狀態: '',
    沖銷txn_id: '',
    txn_id: txnId,
    來源: 'pwa',
    建立時間: '2026-07-26T18:30:00+08:00',
    ...overrides,
  }
}

function ordinaryIncome(txnId: string): JournalRow {
  return {
    ...ordinaryExpense(txnId),
    類型: '收入',
    借方帳戶: '銀行',
    貸方帳戶: '薪資收入',
    金額: 50000,
    分類: '薪資收入',
    交易對象: '',
    說明: '薪資',
  }
}

function ordinaryTransfer(txnId: string): JournalRow {
  return {
    ...ordinaryExpense(txnId),
    類型: '轉帳',
    借方帳戶: '銀行',
    貸方帳戶: '現金',
    金額: 1000,
    分類: '',
    交易對象: '',
    說明: '存款',
  }
}

function receivable(txnId: string, status: string): JournalRow {
  return {
    ...ordinaryExpense(txnId),
    借方帳戶: '應收帳款',
    分類: '',
    交易對象: '阿明',
    說明: '代墊',
    結清狀態: status,
  }
}

function settlement(
  txnId: string,
  originalTxnId: string,
  amount: number,
): JournalRow {
  return {
    ...ordinaryTransfer(txnId),
    日期: '2026-07-27',
    時間: '',
    借方帳戶: '銀行',
    貸方帳戶: '應收帳款',
    金額: amount,
    沖銷txn_id: originalTxnId,
    說明: '',
  }
}

function reversal(txnId: string, originalTxnId: string): JournalRow {
  return {
    ...ordinaryExpense(txnId),
    日期: '2026-07-27',
    時間: '',
    類型: '沖銷',
    借方帳戶: '現金',
    貸方帳戶: '餐飲',
    交易對象: '',
    說明: '',
    沖銷txn_id: originalTxnId,
  }
}

async function postReverse(
  harness: FakeGasHarness,
  idempotencyKey: string,
  overrides: Record<string, unknown> = {},
): Promise<JsonResponse> {
  return post(harness, {
    action: 'reverse_transaction',
    idempotencyKey,
    txn_id: 'expense-001',
    date: '2026-07-27',
    ...overrides,
  }, idempotencyKey)
}

async function postListReceivables(
  harness: FakeGasHarness,
): Promise<Array<{ 交易對象: string; entries: Array<Record<string, unknown>> }>> {
  return await post(
    harness,
    { action: 'list_receivables' },
    `list-receivables-${crypto.randomUUID()}`,
  ) as unknown as Array<{
    交易對象: string
    entries: Array<Record<string, unknown>>
  }>
}

async function post(
  harness: FakeGasHarness,
  payload: Record<string, unknown>,
  nonce: string,
): Promise<JsonResponse> {
  const envelope = await buildEnvelope(
    secret,
    payload,
    Math.floor(fixedNow.getTime() / 1000),
    nonce,
  )
  return parseOutput(
    harness.doPost({ postData: { contents: JSON.stringify(envelope) } }),
  )
}

function parseOutput(output: FakeTextOutput): JsonResponse {
  expect(output.getMimeType()).toBe('application/json')
  return JSON.parse(output.getContent()) as JsonResponse
}

function requiredSheet(harness: FakeGasHarness, name: string): FakeSheet {
  const sheet = harness.spreadsheet.getSheetByName(name)
  if (!sheet) throw new Error(`missing test sheet: ${name}`)
  return sheet
}

function appendJournalRows(harness: FakeGasHarness, rows: JournalRow[]): void {
  const journal = requiredSheet(harness, '日記帳')
  const values = rows.map(row => journalHeaders.map(header => row[header] ?? ''))
  journal
    .getRange(journal.getLastRow() + 1, 1, values.length, journalHeaders.length)
    .setValues(values)
}

function journalRows(harness: FakeGasHarness): JournalRow[] {
  const journal = requiredSheet(harness, '日記帳')
  if (journal.getLastRow() < 2) return []
  const headers = journal
    .getRange(1, 1, 1, journal.getLastColumn())
    .getValues()[0]!
    .map(String)
  return journal
    .getRange(2, 1, journal.getLastRow() - 1, journal.getLastColumn())
    .getValues()
    .map(values =>
      Object.fromEntries(headers.map((header, index) => [header, values[index]])),
    )
}

function journalBytes(harness: FakeGasHarness): string {
  const journal = requiredSheet(harness, '日記帳')
  return JSON.stringify(
    journal
      .getRange(1, 1, journal.getLastRow(), journal.getLastColumn())
      .getValues(),
  )
}

function setAccountEnabled(
  harness: FakeGasHarness,
  accountName: string,
  enabled: boolean,
): void {
  const accounts = requiredSheet(harness, '會計科目')
  const values = accounts
    .getRange(1, 1, accounts.getLastRow(), accounts.getLastColumn())
    .getValues()
  const nameColumn = values[0]!.indexOf('名稱')
  const enabledColumn = values[0]!.indexOf('啟用')
  const row = values.findIndex(valuesRow => valuesRow[nameColumn] === accountName)
  if (row < 1) throw new Error(`missing test account: ${accountName}`)
  accounts.getRange(row + 1, enabledColumn + 1).setValues([[enabled]])
}

function setDefaultCurrency(harness: FakeGasHarness, currency: string): void {
  const settings = requiredSheet(harness, '設定')
  const values = settings
    .getRange(1, 1, settings.getLastRow(), settings.getLastColumn())
    .getValues()
  const keyColumn = values[0]!.indexOf('設定項目')
  const valueColumn = values[0]!.indexOf('值')
  const row = values.findIndex(valuesRow => valuesRow[keyColumn] === '預設幣別')
  if (row < 1) throw new Error('missing 預設幣別 test setting')
  settings.getRange(row + 1, valueColumn + 1).setValues([[currency]])
}
