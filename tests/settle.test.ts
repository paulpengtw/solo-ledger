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

describe('settle', () => {
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

  it('settles an 應收 original with debit settlement account and credit 應收帳款', async () => {
    appendJournalRows(harness, [receivable('receivable-001', 450)])

    const response = await postSettle(harness, 'settle-receivable-001', {
      txn_id: 'receivable-001',
      account: '銀行',
      amount: 200,
    })

    expect(response).toEqual({
      ok: true,
      txn_id: 'settle-receivable-001',
      row: 3,
      outstanding: 250,
      status: '部分',
    })
    expect(journalRows(harness)[1]).toEqual({
      日期: '2026-07-27',
      時間: '',
      類型: '轉帳',
      借方帳戶: '銀行',
      貸方帳戶: '應收帳款',
      金額: 200,
      幣別: 'TWD',
      分類: '',
      交易對象: '',
      說明: '',
      結清狀態: '',
      沖銷txn_id: 'receivable-001',
      txn_id: 'settle-receivable-001',
      來源: 'pwa',
      建立時間: '2026-07-27T08:00:00.000+08:00',
    })
  })

  it('settles an 應付 original with debit 應付帳款 and credit settlement account', async () => {
    appendJournalRows(harness, [payable('payable-001', 720)])

    const response = await postSettle(harness, 'settle-payable-001', {
      txn_id: 'payable-001',
      account: '銀行',
      amount: 300,
    })

    expect(response).toEqual({
      ok: true,
      txn_id: 'settle-payable-001',
      row: 3,
      outstanding: 420,
      status: '部分',
    })
    expect(journalRows(harness)[1]).toEqual({
      日期: '2026-07-27',
      時間: '',
      類型: '轉帳',
      借方帳戶: '應付帳款',
      貸方帳戶: '銀行',
      金額: 300,
      幣別: 'TWD',
      分類: '',
      交易對象: '',
      說明: '',
      結清狀態: '',
      沖銷txn_id: 'payable-001',
      txn_id: 'settle-payable-001',
      來源: 'pwa',
      建立時間: '2026-07-27T08:00:00.000+08:00',
    })
  })

  it('uses the remaining outstanding when amount is omitted', async () => {
    appendJournalRows(harness, [
      receivable('remaining-001', 500),
      settlement('earlier-settlement-001', 'remaining-001', 125),
    ])

    await postSettle(harness, 'settle-remaining-001', {
      txn_id: 'remaining-001',
      account: '銀行',
    })

    expect(journalRows(harness)[2]).toMatchObject({
      金額: 375,
      沖銷txn_id: 'remaining-001',
    })
    expect(journalRows(harness)[0]?.結清狀態).toBe('已結')
  })

  it('recomputes 部分 and the numeric remainder, then closes on a second settle', async () => {
    appendJournalRows(harness, [receivable('two-step-001', 500)])

    await postSettle(harness, 'settle-partial-001', {
      txn_id: 'two-step-001',
      account: '銀行',
      amount: 180,
    })

    expect(journalRows(harness)[0]?.結清狀態).toBe('部分')
    expect(await postListReceivables(harness)).toEqual([
      {
        交易對象: '阿明',
        entries: [
          expect.objectContaining({
            txn_id: 'two-step-001',
            outstanding: 320,
            結清狀態: '部分',
          }),
        ],
      },
    ])

    await postSettle(harness, 'settle-close-001', {
      txn_id: 'two-step-001',
      account: '銀行',
    })

    expect(journalRows(harness)[0]?.結清狀態).toBe('已結')
    expect(journalRows(harness)[2]).toMatchObject({ 金額: 320 })
    expect(await postListReceivables(harness)).toEqual([])
  })

  it('rejects over-settlement without appending or changing status', async () => {
    appendJournalRows(harness, [receivable('over-001', 100)])
    const before = journalBytes(harness)

    const response = await postSettle(harness, 'settle-over-001', {
      txn_id: 'over-001',
      account: '銀行',
      amount: 101,
    })

    expect(response).toEqual({
      ok: false,
      error: 'over-settlement: amount 101 exceeds outstanding 100',
    })
    expect(journalBytes(harness)).toBe(before)
  })

  it('rejects an original currency differing from the current default without writing', async () => {
    appendJournalRows(harness, [
      { ...receivable('foreign-001', 100), 幣別: 'USD' },
    ])
    const before = journalBytes(harness)

    const response = await postSettle(harness, 'settle-foreign-001', {
      txn_id: 'foreign-001',
      account: '銀行',
    })

    expect(response).toEqual({
      ok: false,
      error: 'original currency USD differs from default TWD',
    })
    expect(journalBytes(harness)).toBe(before)
  })

  it('always stamps the current default currency on the settlement row', async () => {
    setDefaultCurrency(harness, 'JPY')
    appendJournalRows(harness, [
      { ...receivable('currency-stamp-001', 100), 幣別: 'JPY' },
    ])

    await postSettle(harness, 'settle-currency-stamp-001', {
      txn_id: 'currency-stamp-001',
      account: '銀行',
    })

    expect(journalRows(harness)[1]?.幣別).toBe('JPY')
  })

  it.each([
    ['unknown', '幽靈銀行'],
    ['disabled', '銀行'],
  ])('rejects an %s requested settlement account without writing', async (kind, account) => {
    appendJournalRows(harness, [receivable(`account-${kind}-001`, 100)])
    if (kind === 'disabled') setAccountEnabled(harness, account, false)
    const before = journalBytes(harness)

    const response = await postSettle(harness, `settle-account-${kind}-001`, {
      txn_id: `account-${kind}-001`,
      account,
    })

    expect(response).toEqual({
      ok: false,
      error: `unknown or disabled account: ${account}`,
    })
    expect(journalBytes(harness)).toBe(before)
  })

  it('allows a disabled 應收帳款 or 應付帳款 when it is only the derived leg', async () => {
    setAccountEnabled(harness, '應收帳款', false)
    setAccountEnabled(harness, '應付帳款', false)
    appendJournalRows(harness, [
      receivable('disabled-derived-receivable-001', 100),
      payable('disabled-derived-payable-001', 200),
    ])

    const received = await postSettle(
      harness,
      'settle-disabled-derived-receivable-001',
      {
        txn_id: 'disabled-derived-receivable-001',
        account: '銀行',
      },
    )
    const paid = await postSettle(
      harness,
      'settle-disabled-derived-payable-001',
      {
        txn_id: 'disabled-derived-payable-001',
        account: '銀行',
      },
    )

    expect(received.ok).toBe(true)
    expect(paid.ok).toBe(true)
    expect(journalRows(harness).slice(-2)).toEqual([
      expect.objectContaining({
        借方帳戶: '銀行',
        貸方帳戶: '應收帳款',
      }),
      expect.objectContaining({
        借方帳戶: '應付帳款',
        貸方帳戶: '銀行',
      }),
    ])
  })

  it('uses the journal txn_id backstop when the nonce cache is empty', async () => {
    appendJournalRows(harness, [
      receivable('journal-backstop-original-001', 100),
      settlement(
        'settle-journal-backstop-001',
        'journal-backstop-original-001',
        40,
      ),
    ])
    const before = journalBytes(harness)
    expect(harness.peekCache('nonce:settle-journal-backstop-001')).toBeNull()

    const response = await postSettle(
      harness,
      'settle-journal-backstop-001',
      {
        txn_id: 'journal-backstop-original-001',
        account: '銀行',
        amount: 40,
      },
    )

    expect(response).toEqual({ ok: true, already: true })
    expect(journalBytes(harness)).toBe(before)
  })

  it('returns already from journal arithmetic when the original is fully settled', async () => {
    appendJournalRows(harness, [
      { ...receivable('already-closed-001', 100), 結清狀態: '已結' },
      settlement('prior-close-001', 'already-closed-001', 100),
    ])
    const before = journalBytes(harness)

    const response = await postSettle(harness, 'new-key-against-closed-001', {
      txn_id: 'already-closed-001',
      account: '銀行',
    })

    expect(response).toEqual({ ok: true, already: true })
    expect(journalBytes(harness)).toBe(before)
  })

  it('writes the settlement row before the original status cell and commits nonce last', async () => {
    appendJournalRows(harness, [receivable('write-order-001', 100)])
    harness.clearEvents()

    await postSettle(harness, 'settle-write-order-001', {
      txn_id: 'write-order-001',
      account: '銀行',
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

  it('derives zero outstanding through a stale status after a crash between writes', async () => {
    appendJournalRows(harness, [receivable('crash-safe-001', 100)])
    const journal = requiredSheet(harness, '日記帳')
    const statusColumn = journalHeaders.indexOf('結清狀態') + 1
    journal.failNextSetValuesInColumn(statusColumn, 'simulated status-write crash')
    harness.clearEvents()

    const response = await postSettle(harness, 'settle-crash-safe-001', {
      txn_id: 'crash-safe-001',
      account: '銀行',
    })

    expect(response).toEqual({
      ok: false,
      error: 'simulated status-write crash',
    })
    expect(harness.events).toEqual([
      'lock-acquired',
      'nonce-checked',
      'row-written',
      'lock-released',
    ])
    expect(journalRows(harness)[0]?.結清狀態).toBe('未結')
    expect(journalRows(harness)[1]).toMatchObject({
      金額: 100,
      沖銷txn_id: 'crash-safe-001',
    })

    const groups = await postListReceivables(harness)
    expect(groups[0]?.entries[0]).toMatchObject({
      txn_id: 'crash-safe-001',
      結清狀態: '未結',
      outstanding: 0,
    })
  })

  it('rejects a currency input field instead of accepting settlement currency from the request', async () => {
    appendJournalRows(harness, [receivable('request-currency-001', 100)])
    const before = journalBytes(harness)

    const response = await postSettle(harness, 'settle-request-currency-001', {
      txn_id: 'request-currency-001',
      account: '銀行',
      currency: 'USD',
    })

    expect(response).toEqual({ ok: false, error: 'currency is rejected' })
    expect(journalBytes(harness)).toBe(before)
  })
})

describe('list_receivables', () => {
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

  it('groups open rows by 交易對象 and derives outstanding, including view-only hand rows', async () => {
    appendJournalRows(harness, [
      {
        ...receivable('open-receivable-001', 500),
        說明: '代買車票',
      },
      settlement('partial-a-001', 'open-receivable-001', 100),
      settlement('partial-b-001', 'open-receivable-001', 50),
      {
        ...payable('partial-payable-001', 720),
        交易對象: '小美',
        說明: '朋友先付晚餐',
        結清狀態: '部分',
      },
      {
        ...receivable('', 80),
        日期: '2026-07-25',
        說明: '手動代墊',
        來源: '手動',
      },
      {
        ...receivable('closed-001', 90),
        結清狀態: '已結',
      },
      {
        ...payable('reversed-001', 60),
        結清狀態: '已沖銷',
      },
    ])
    harness.clearEvents()

    const response = await postListReceivables(harness)

    expect(response).toEqual([
      {
        交易對象: '阿明',
        entries: [
          {
            txn_id: 'open-receivable-001',
            日期: '2026-07-26',
            金額: 500,
            幣別: 'TWD',
            交易對象: '阿明',
            說明: '代買車票',
            結清狀態: '未結',
            direction: '應收',
            outstanding: 350,
            view_only: false,
          },
          {
            txn_id: '',
            日期: '2026-07-25',
            金額: 80,
            幣別: 'TWD',
            交易對象: '阿明',
            說明: '手動代墊',
            結清狀態: '未結',
            direction: '應收',
            outstanding: 80,
            view_only: true,
          },
        ],
      },
      {
        交易對象: '小美',
        entries: [
          {
            txn_id: 'partial-payable-001',
            日期: '2026-07-26',
            金額: 720,
            幣別: 'TWD',
            交易對象: '小美',
            說明: '朋友先付晚餐',
            結清狀態: '部分',
            direction: '應付',
            outstanding: 720,
            view_only: false,
          },
        ],
      },
    ])
    expect(harness.events).not.toContain('lock-acquired')
    expect(harness.events).not.toContain('lock-released')
  })
})

type JsonResponse = Record<string, unknown>
type JournalRow = Record<string, unknown>

function receivable(txnId: string, amount: number): JournalRow {
  return {
    日期: '2026-07-26',
    時間: '12:30',
    類型: '支出',
    借方帳戶: '應收帳款',
    貸方帳戶: '現金',
    金額: amount,
    幣別: 'TWD',
    分類: '',
    交易對象: '阿明',
    說明: '代墊',
    結清狀態: '未結',
    沖銷txn_id: '',
    txn_id: txnId,
    來源: 'pwa',
    建立時間: '2026-07-26T12:30:00+08:00',
  }
}

function payable(txnId: string, amount: number): JournalRow {
  return {
    日期: '2026-07-26',
    時間: '12:30',
    類型: '支出',
    借方帳戶: '餐飲',
    貸方帳戶: '應付帳款',
    金額: amount,
    幣別: 'TWD',
    分類: '餐飲',
    交易對象: '阿明',
    說明: '朋友先付',
    結清狀態: '未結',
    沖銷txn_id: '',
    txn_id: txnId,
    來源: 'pwa',
    建立時間: '2026-07-26T12:30:00+08:00',
  }
}

function settlement(txnId: string, originalTxnId: string, amount: number): JournalRow {
  return {
    日期: '2026-07-27',
    時間: '',
    類型: '轉帳',
    借方帳戶: '銀行',
    貸方帳戶: '應收帳款',
    金額: amount,
    幣別: 'TWD',
    分類: '',
    交易對象: '',
    說明: '',
    結清狀態: '',
    沖銷txn_id: originalTxnId,
    txn_id: txnId,
    來源: 'pwa',
    建立時間: '2026-07-27T08:00:00+08:00',
  }
}

async function postSettle(
  harness: FakeGasHarness,
  idempotencyKey: string,
  overrides: Record<string, unknown> = {},
): Promise<JsonResponse> {
  return post(harness, {
    action: 'settle',
    idempotencyKey,
    txn_id: 'receivable-001',
    account: '銀行',
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
