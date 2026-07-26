import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildEnvelope } from '../functions/lib/envelope'
import {
  loadGasFunctionsWithFakeGas,
  type FakeGasHarness,
  type FakeSheet,
  type FakeTextOutput,
} from './helpers/gas'

const secret = 'test-secret'
const spreadsheetId = 'test-ledger-spreadsheet-id'
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
  '對象',
  '說明',
  '結清狀態',
  '沖銷txn_id',
  'txn_id',
  '來源',
  '建立時間',
]

describe('doPost', () => {
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

  it('returns health identity without disclosing the full spreadsheet id', async () => {
    const response = await post(harness, {
      action: 'health',
    }, 'health-001')

    expect(response.ok).toBe(true)
    expect(new Date(String(response.now)).toISOString()).toBe(String(response.now))
    expect(response.schema_version).toMatch(/^[0-9a-f]{12}$/)
    expect(response.spreadsheet_id_tail).toBe(spreadsheetId.slice(-8))
    expect(response.spreadsheet_id_tail).not.toBe(spreadsheetId)
  })

  it('keeps schema_version stable for identical content and changes it with vocabulary', async () => {
    const first = await post(harness, { action: 'health' }, 'health-schema-001')
    const second = await post(harness, { action: 'health' }, 'health-schema-002')

    expect(second.schema_version).toBe(first.schema_version)

    const accounts = requiredSheet(harness, '會計科目')
    accounts.getRange(2, 1).setValues([['更名後期初餘額']])
    const changed = await post(harness, { action: 'health' }, 'health-schema-003')

    expect(changed.schema_version).not.toBe(first.schema_version)
  })

  it('appends exactly one column-complete expense row with the §5.1 legs', async () => {
    const response = await postCreate(harness, 'create-001', {
      type: '支出',
      date: '2026-07-26',
      time: '12:30',
      amount: 260,
      currency: 'TWD',
      account: '現金',
      category: '餐飲',
      payee: '路易莎',
      description: '午餐',
    })

    expect(response).toMatchObject({ ok: true, txn_id: 'create-001', row: 2 })
    expect(journalRows(harness)).toEqual([
      {
        日期: '2026-07-26',
        時間: '12:30',
        類型: '支出',
        借方帳戶: '餐飲',
        貸方帳戶: '現金',
        金額: 260,
        幣別: 'TWD',
        分類: '餐飲',
        對象: '路易莎',
        說明: '午餐',
        結清狀態: '',
        沖銷txn_id: '',
        txn_id: 'create-001',
        來源: 'pwa',
        建立時間: '2026-07-27T08:00:00.000+08:00',
      },
    ])
  })

  it('rejects a bad signature without acquiring the lock', async () => {
    const envelope = await buildEnvelope(secret, createPayload('bad-signature-001'), nowSeconds(), 'bad-signature-001')
    envelope.sig = `${envelope.sig.slice(0, -1)}${envelope.sig.endsWith('A') ? 'B' : 'A'}`

    const response = postEnvelope(harness, envelope)

    expect(response).toEqual({ ok: false, error: 'bad signature' })
    expect(harness.events).not.toContain('lock-acquired')
  })

  it('orders successful create work inside the lock through nonce commit', async () => {
    await postCreate(harness, 'ordered-create-001')

    expect(harness.events).toEqual([
      'lock-acquired',
      'nonce-checked',
      'row-written',
      'nonce-committed',
      'lock-released',
    ])
  })

  it('returns the stored successful result with already true on nonce replay', async () => {
    const payload = createPayload('replay-001')
    const envelope = await buildEnvelope(secret, payload, nowSeconds(), 'replay-001')

    const first = postEnvelope(harness, envelope)
    const second = postEnvelope(harness, envelope)

    expect(journalRows(harness)).toHaveLength(1)
    expect(second).toEqual({ ...first, already: true })
  })

  it('does not cache a failed write and genuinely retries the same envelope', async () => {
    const journal = requiredSheet(harness, '日記帳')
    journal.failNextSetValues('simulated append failure')
    const payload = createPayload('retry-after-write-failure-001')
    const envelope = await buildEnvelope(secret, payload, nowSeconds(), 'retry-after-write-failure-001')

    const failed = postEnvelope(harness, envelope)

    expect(failed).toEqual({ ok: false, error: 'simulated append failure' })
    expect(harness.peekCache('nonce:retry-after-write-failure-001')).toBeNull()
    expect(journalRows(harness)).toHaveLength(0)

    const retried = postEnvelope(harness, envelope)

    expect(retried).toMatchObject({ ok: true, txn_id: 'retry-after-write-failure-001', row: 2 })
    expect(journalRows(harness)).toHaveLength(1)
  })

  it('uses txn_id as a durable backstop after nonce cache expiry', async () => {
    const payload = createPayload('durable-backstop-001')
    const envelope = await buildEnvelope(secret, payload, nowSeconds(), 'durable-backstop-001')
    const first = postEnvelope(harness, envelope)
    harness.advanceCacheTime(601)

    const replayed = postEnvelope(harness, envelope)

    expect(journalRows(harness)).toHaveLength(1)
    expect(replayed).toEqual({ ...first, already: true })
  })

  it.each([
    ['past', -301],
    ['future', 301],
  ])('rejects a timestamp more than 300 seconds in the %s without locking', async (_label, offset) => {
    const nonce = `skew-${offset}`
    const envelope = await buildEnvelope(secret, createPayload(nonce), nowSeconds() + offset, nonce)

    const response = postEnvelope(harness, envelope)

    expect(response).toEqual({ ok: false, error: 'request timestamp outside allowed window' })
    expect(harness.events).not.toContain('lock-acquired')
  })

  it('names an unknown account in a vocabulary error', async () => {
    const response = await postCreate(harness, 'unknown-account-001', { account: '幽靈錢包' })

    expect(response).toEqual({ ok: false, error: 'unknown or disabled account: 幽靈錢包' })
  })

  it('names a disabled account in a vocabulary error', async () => {
    setAccountEnabled(harness, '現金', false)

    const response = await postCreate(harness, 'disabled-account-001')

    expect(response).toEqual({ ok: false, error: 'unknown or disabled account: 現金' })
  })

  it('names an unknown category in a vocabulary error', async () => {
    const response = await postCreate(harness, 'unknown-category-001', { category: '深夜點心' })

    expect(response).toEqual({ ok: false, error: 'unknown or disabled category: 深夜點心' })
  })

  it('fails loudly with the name of a missing required journal header', async () => {
    const journal = requiredSheet(harness, '日記帳')
    const missingHeader = '貸方帳戶'
    journal.getRange(1, journalHeaders.indexOf(missingHeader) + 1).setValues([['']])

    const response = await postCreate(harness, 'missing-header-001')

    expect(response.ok).toBe(false)
    expect(response.error).toContain(`missing required header: ${missingHeader}`)
  })

  it('uses 預設幣別 and writes a blank 時間 when both are omitted', async () => {
    const response = await postCreate(harness, 'defaults-001', { time: undefined, currency: undefined })

    expect(response.ok).toBe(true)
    expect(journalRows(harness)[0]).toMatchObject({ 時間: '', 幣別: 'TWD' })
  })

  it('returns a named error for actions outside the phase-one route set', async () => {
    const response = await post(harness, { action: 'setupSpreadsheet' }, 'unsupported-action-001')

    expect(response).toEqual({ ok: false, error: 'unsupported action: setupSpreadsheet' })
  })
})

type JsonResponse = Record<string, unknown>
type Transaction = Record<string, unknown>

async function post(
  harness: FakeGasHarness,
  payload: Record<string, unknown>,
  nonce: string,
): Promise<JsonResponse> {
  const envelope = await buildEnvelope(secret, payload, nowSeconds(), nonce)
  return postEnvelope(harness, envelope)
}

async function postCreate(
  harness: FakeGasHarness,
  idempotencyKey: string,
  overrides: Transaction = {},
): Promise<JsonResponse> {
  return post(harness, createPayload(idempotencyKey, overrides), idempotencyKey)
}

function postEnvelope(harness: FakeGasHarness, envelope: unknown): JsonResponse {
  return parseOutput(harness.doPost({ postData: { contents: JSON.stringify(envelope) } }))
}

function parseOutput(output: FakeTextOutput): JsonResponse {
  expect(output.getMimeType()).toBe('application/json')
  return JSON.parse(output.getContent()) as JsonResponse
}

function createPayload(idempotencyKey: string, overrides: Transaction = {}): Record<string, unknown> {
  return {
    action: 'create_transaction',
    idempotencyKey,
    transaction: {
      type: '支出',
      date: '2026-07-26',
      time: '12:30',
      amount: 260,
      currency: 'TWD',
      account: '現金',
      category: '餐飲',
      payee: '路易莎',
      description: '午餐',
      ...overrides,
    },
  }
}

function nowSeconds(): number {
  return Math.floor(fixedNow.getTime() / 1000)
}

function requiredSheet(harness: FakeGasHarness, name: string): FakeSheet {
  const sheet = harness.spreadsheet.getSheetByName(name)
  if (!sheet) {
    throw new Error(`missing test sheet: ${name}`)
  }
  return sheet
}

function journalRows(harness: FakeGasHarness): Array<Record<string, unknown>> {
  const journal = requiredSheet(harness, '日記帳')
  const lastRow = journal.getLastRow()
  if (lastRow < 2) {
    return []
  }
  const headers = journal.getRange(1, 1, 1, journal.getLastColumn()).getValues()[0]!.map(String)
  return journal.getRange(2, 1, lastRow - 1, journal.getLastColumn()).getValues().map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index]])),
  )
}

function setAccountEnabled(harness: FakeGasHarness, accountName: string, enabled: boolean): void {
  const accounts = requiredSheet(harness, '會計科目')
  const values = accounts.getRange(1, 1, accounts.getLastRow(), accounts.getLastColumn()).getValues()
  const nameColumn = values[0]!.indexOf('名稱')
  const enabledColumn = values[0]!.indexOf('啟用')
  const row = values.findIndex((valuesRow) => valuesRow[nameColumn] === accountName)
  if (row < 1) {
    throw new Error(`missing test account: ${accountName}`)
  }
  accounts.getRange(row + 1, enabledColumn + 1).setValues([[enabled]])
}
