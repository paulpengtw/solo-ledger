import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildEnvelope as productionBuildEnvelope } from '../functions/lib/envelope'
import { CONTRACT_VERSION } from '../src/generated/version'
import {
  loadGasFunctionsWithFakeGas,
  type FakeGasHarness,
  type FakeSheet,
  type FakeTextOutput,
} from './helpers/gas'

const secret = 'test-secret'
const fixedNow = new Date('2026-07-27T00:00:00.000Z')
const journalHeaders = [
  '日期', '時間', '類型', '借方帳戶', '貸方帳戶', '金額', '幣別', '分類',
  '交易對象', '說明', '結清狀態', '沖銷txn_id', 'txn_id', '來源', '建立時間',
]

describe('Personal read snapshots', () => {
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

  it('reports the Personal read capability with identity, maintenance, and server read time', async () => {
    expect(await post(harness, { action: 'integrationState' }, 'integration-state-001')).toEqual({
      book: 'personal',
      identity: {
        contractVersion: CONTRACT_VERSION,
        appVersion: expect.stringMatching(/^[0-9a-f]{40}$/),
      },
      maintenance: { kind: 'open' },
      capabilities: ['complete-revisioned-reads', 'stable-identity'],
      readAt: '2026-07-27T08:00:00.000+08:00',
    })
  })

  it('derives enabled asset and liability balances exactly within each native currency', async () => {
    const accounts = requiredSheet(harness, '會計科目')
    accounts.getRange(accounts.getLastRow() + 1, 1, 1, 5).setValues([
      ['信用卡', '負債', '信用卡', true, 130],
    ])
    setAccountEnabled(harness, '悠遊卡', false)
    appendJournalRows(harness, [
      journalRow('2026-07-20', '現金', '薪資收入', '1000000000000000000.10', 'TWD', 'income-twd'),
      journalRow('2026-07-21', '餐飲', '現金', '0.20', 'TWD', 'expense-twd'),
      journalRow('2026-07-22', '現金', '薪資收入', '10.005', 'USD', 'income-usd'),
      journalRow('2026-07-23', '餐飲', '現金', '0.005', 'USD', 'expense-usd'),
      journalRow('2026-07-24', '餐飲', '信用卡', '20.30', 'USD', 'card-charge'),
      journalRow('2026-07-25', '信用卡', '現金', '0.10', 'USD', 'card-payment'),
      journalRow('2026-07-26', '銀行', '薪資收入', '0.10', 'TWD', 'bank-in'),
      journalRow('2026-07-27', '餐飲', '銀行', '0.10', 'TWD', 'bank-out'),
    ])

    const response = await postSnapshot(harness, 'accounts', 'accounts-001')
    const revision = String(response.snapshotRevision)
    const records = response.records as Array<Record<string, unknown>>

    expect(revision).toMatch(/^[0-9a-f]{64}$/)
    expect(response).toMatchObject({
      scope: 'accounts',
      continuation: { kind: 'end' },
      readAt: '2026-07-27T08:00:00.000+08:00',
    })
    expect(records.map(record => record.name)).toEqual([
      '應收帳款', '應付帳款', '現金', '銀行', '信用卡',
    ])
    expect(records).toContainEqual(expect.objectContaining({
      id: stableAccountId(harness, '現金'),
      name: '現金',
      type: '資產',
      subtype: '現金',
      enabled: true,
      sort: 100,
      balances: [
        { amount: '999999999999999999.9', currency: 'TWD' },
        { amount: '9.9', currency: 'USD' },
      ],
    }))
    expect(records).toContainEqual(expect.objectContaining({
      id: stableAccountId(harness, '銀行'),
      balances: [{ amount: '0', currency: 'TWD' }],
    }))
    expect(records).toContainEqual(expect.objectContaining({
      id: 'account:信用卡',
      type: '負債',
      balances: [{ amount: '20.2', currency: 'USD' }],
    }))
    for (const record of records) {
      expect(record).toMatchObject({
        financialCutoff: {
          basis: 'all-posted-journal-entries',
          throughFinancialDate: '2026-07-27',
        },
        completion: {
          kind: 'complete',
          source: '日記帳',
          sourceRowCount: 8,
          sourceLastRow: 9,
          snapshotRevision: revision,
        },
      })
    }
  })

  it('returns every actual journal row with complete fields and explicit blank identity', async () => {
    writeJournalRowsAt(harness, 2, [
      {
        日期: '2026-07-20',
        時間: '09:08',
        類型: '收入',
        借方帳戶: '現金',
        貸方帳戶: '薪資收入',
        金額: '001,234.5000',
        幣別: 'EUR',
        分類: '薪資收入',
        交易對象: '測試雇主',
        說明: '合成薪資',
        結清狀態: '已結',
        沖銷txn_id: 'prior-id',
        txn_id: 'event-identified',
        來源: 'test-fixture',
        建立時間: '2026-07-20T09:08:07+08:00',
      },
    ])
    writeJournalRowsAt(harness, 4, [
      journalRow('2026-07-21', '餐飲', '現金', '0.0100', 'TWD', ''),
    ])

    const response = await postSnapshot(harness, 'events', 'events-001')

    expect(response).toMatchObject({
      scope: 'events',
      snapshotRevision: expect.stringMatching(/^[0-9a-f]{64}$/),
      continuation: { kind: 'end' },
      readAt: '2026-07-27T08:00:00.000+08:00',
    })
    expect(response.records).toEqual([
      expect.objectContaining({
        id: 'event-identified',
        identity: { kind: 'identified', txnId: 'event-identified' },
        financialDate: '2026-07-20',
        time: '09:08',
        type: '收入',
        debitAccount: '現金',
        creditAccount: '薪資收入',
        amount: { amount: '1234.5', currency: 'EUR' },
        category: '薪資收入',
        counterparty: '測試雇主',
        description: '合成薪資',
        settlementStatus: '已結',
        reversalTxnId: 'prior-id',
        source: 'test-fixture',
        createdAt: '2026-07-20T09:08:07+08:00',
        sheetRow: 2,
        contentDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        repairReference: {
          scope: 'events',
          sheetRow: 2,
          contentDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      }),
      expect.objectContaining({
        id: null,
        identity: { kind: 'unidentified', reason: 'blank-txn-id' },
        financialDate: '2026-07-21',
        time: '12:34',
        type: '測試',
        debitAccount: '餐飲',
        creditAccount: '現金',
        amount: { amount: '0.01', currency: 'TWD' },
        category: '測試分類',
        counterparty: '測試對象',
        description: '合成測試資料',
        settlementStatus: '',
        reversalTxnId: '',
        source: 'test-fixture',
        createdAt: '2026-07-21T12:34:00+08:00',
        sheetRow: 4,
        contentDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        repairReference: {
          scope: 'events',
          sheetRow: 4,
          contentDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      }),
    ])

    const accounts = await postSnapshot(harness, 'accounts', 'accounts-gap-001')
    for (const record of accounts.records as Array<Record<string, unknown>>) {
      expect(record).toMatchObject({
        completion: {
          sourceRowCount: 2,
          sourceLastRow: 4,
          snapshotRevision: accounts.snapshotRevision,
        },
      })
    }
  })

  it('pages more than 200 same-date events and proves the end explicitly', async () => {
    appendJournalRows(
      harness,
      Array.from({ length: 201 }, (_unused, index) =>
        journalRow(
          '2026-07-27',
          '餐飲',
          '現金',
          String(index + 1),
          'TWD',
          `event-${String(index + 1).padStart(3, '0')}`,
        )),
    )

    const first = await postSnapshot(harness, 'events', 'events-page-001')
    const revision = String(first.snapshotRevision)
    expect((first.records as unknown[])).toHaveLength(200)
    expect(first.continuation).toEqual({ kind: 'cursor', cursor: '200' })

    const second = await postSnapshot(harness, 'events', 'events-page-002', {
      cursor: '200',
      snapshotRevision: revision,
    })
    expect(second).toMatchObject({
      scope: 'events',
      snapshotRevision: revision,
      continuation: { kind: 'end' },
    })
    expect(second.records).toEqual([
      expect.objectContaining({ id: 'event-201', sheetRow: 202 }),
    ])
  })

  it('materializes and hashes only the events on a continuation page', async () => {
    appendJournalRows(
      harness,
      Array.from({ length: 201 }, (_unused, index) => ({
        ...journalRow(
          '2026-07-27',
          '餐飲',
          '現金',
          String(index + 1),
          'TWD',
          `page-event-${String(index + 1).padStart(3, '0')}`,
        ),
        說明: index === 200
          ? 'continuation-only-event'
          : `first-page-event-${index + 1}`,
      })),
    )

    const first = await postSnapshot(harness, 'events', 'event-page-work-001')
    harness.clearDigestInputs()

    const second = await postSnapshot(harness, 'events', 'event-page-work-002', {
      cursor: '200',
      snapshotRevision: String(first.snapshotRevision),
    })

    const eventDigestInputs = harness.digestInputs.filter(input =>
      input.startsWith('{"scope":"events"'),
    )
    expect(second.records).toEqual([
      expect.objectContaining({
        id: 'page-event-201',
        description: 'continuation-only-event',
        sheetRow: 202,
        contentDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        repairReference: {
          scope: 'events',
          sheetRow: 202,
          contentDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      }),
    ])
    const record = (second.records as Array<Record<string, unknown>>)[0]!
    expect(record.repairReference).toEqual({
      scope: 'events',
      sheetRow: 202,
      contentDigest: record.contentDigest,
    })
    expect(harness.digestInputs).toHaveLength(2)
    expect(eventDigestInputs).toHaveLength(1)
    expect(eventDigestInputs.every(input => input.includes('continuation-only-event'))).toBe(true)
    expect(eventDigestInputs.every(input => !input.includes('first-page-event-1'))).toBe(true)
  })

  it('reads each populated E2 table once per event snapshot page', async () => {
    await post(harness, { action: 'enable_e2', contractVersion: CONTRACT_VERSION }, 'events-e2-read-once-enable')
    requiredSheet(harness, '事件群組').getRange(2, 1, 1, 8).setValues([[
      'events-read-once-group', 'complete', '[]', 'complete-marker', 'group-digest',
      '2026-07-27', '2026-07-27', 'test',
    ]])
    requiredSheet(harness, '事件群組明細').getRange(2, 1, 1, 8).setValues([[
      'events-read-once-group', 'events-read-once-event', '0', '1', 'TWD', '餐飲', '現金',
      'detail-digest',
    ]])
    requiredSheet(harness, '事件審核').getRange(2, 1, 1, 6).setValues([[
      'events-read-once-event', '餐飲', 'confirmed', 'review-revision', 'review-operation',
      '2026-07-27',
    ]])
    appendJournalRows(harness, [
      journalRow('2026-07-27', '餐飲', '現金', '1', 'TWD', 'events-read-once-event'),
      ...Array.from({ length: 472 }, (_unused, index) =>
        journalRow('2026-07-27', '餐飲', '現金', '1', 'TWD', `events-read-once-${index + 2}`)),
    ])

    const pageSizes: number[] = []
    let enrichedRecordFound = false
    let cursor: string | undefined
    let snapshotRevision: string | undefined
    for (;;) {
      harness.clearRangeReadCounts()
      const page = await postSnapshot(harness, 'events', `events-e2-read-once-${pageSizes.length}`, {
        ...(cursor === undefined ? {} : { cursor }),
        ...(snapshotRevision === undefined ? {} : { snapshotRevision }),
      })
      if (snapshotRevision === undefined) snapshotRevision = String(page.snapshotRevision)
      pageSizes.push((page.records as unknown[]).length)
      enrichedRecordFound = enrichedRecordFound || (page.records as Array<Record<string, unknown>>).some(record =>
        record.id === 'events-read-once-event' &&
        record.groupId === 'events-read-once-group' &&
        record.groupCompletion === 'complete' &&
        record.reviewState === 'confirmed')
      expect(harness.dataRangeReadCounts['事件群組']).toBe(1)
      expect(harness.dataRangeReadCounts['事件群組明細']).toBe(1)
      expect(harness.dataRangeReadCounts['事件審核']).toBe(1)
      const continuation = page.continuation as { kind: string; cursor?: string }
      if (continuation.kind === 'end') {
        break
      }
      expect(continuation.kind).toBe('cursor')
      cursor = continuation.cursor
    }

    expect(pageSizes).toEqual([200, 200, 73])
    expect(enrichedRecordFound).toBe(true)
  })

  it('refuses to stitch a continuation after the journal source changes', async () => {
    appendJournalRows(
      harness,
      Array.from({ length: 201 }, (_unused, index) =>
        journalRow(
          '2026-07-27',
          '餐飲',
          '現金',
          '1',
          'TWD',
          `revision-event-${index + 1}`,
        )),
    )
    const first = await postSnapshot(harness, 'events', 'revision-page-001')
    const oldRevision = String(first.snapshotRevision)
    requiredSheet(harness, '日記帳').getRange(2, 10).setValues([['changed after page one']])

    const second = await postSnapshot(harness, 'events', 'revision-page-002', {
      cursor: '200',
      snapshotRevision: oldRevision,
    })

    expect(second).toEqual({
      kind: 'revision-changed',
      book: 'personal',
      expected: oldRevision,
      actual: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(second.actual).not.toBe(oldRevision)
  })

  it('moves the data revision when enabled account vocabulary changes', async () => {
    const first = await postSnapshot(harness, 'accounts', 'vocabulary-revision-001')
    const oldRevision = String(first.snapshotRevision)
    const accounts = requiredSheet(harness, '會計科目')
    accounts.getRange(7, 3).setValues([['更精確的現金分類']])

    const changed = await postSnapshot(harness, 'accounts', 'vocabulary-revision-002', {
      snapshotRevision: oldRevision,
    })
    expect(changed).toEqual({
      kind: 'revision-changed',
      book: 'personal',
      expected: oldRevision,
      actual: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(changed.actual).not.toBe(oldRevision)
  })

  it('keeps signed snapshots behind maintenance and contract-version gates', async () => {
    harness.setScriptProperty('INTEGRATION_OPEN', 'false')
    expect(await postSnapshot(harness, 'events', 'snapshot-closed')).toEqual({
      ok: false,
      error: '系統更新中',
    })

    harness.setScriptProperty('INTEGRATION_OPEN', 'true')
    expect(await post(harness, {
      action: 'snapshot',
      scope: 'events',
      contractVersion: 'obsolete-contract',
    }, 'snapshot-old-contract')).toEqual({
      ok: false,
      error: '版本已更新，請重新整理頁面',
    })
  })

  it('refuses a nonblank partial source row before claiming complete account evidence', async () => {
    const journal = requiredSheet(harness, '日記帳')
    journal.getRange(2, journalHeaders.length + 1).setValues([['stray partial source']])

    const events = await postSnapshot(harness, 'events', 'events-stray-001')
    expect(events).toEqual({
      ok: false,
      error: 'invalid journal row at row 2: financial date is required',
    })

    const accounts = await postSnapshot(harness, 'accounts', 'accounts-stray-001')
    expect(accounts).toEqual({
      ok: false,
      error: 'invalid journal row at row 2: financial date is required',
    })
  })

  it('refuses a structurally complete row that never reaches an asset or liability', async () => {
    appendJournalRows(harness, [
      journalRow('2026-07-27', '餐飲', '交通', '12.30', 'TWD', 'category-only'),
    ])

    expect(await postSnapshot(harness, 'accounts', 'accounts-category-only')).toEqual({
      ok: false,
      error: 'invalid journal row at row 2: no asset or liability account',
    })
  })

  it('canonicalizes a negative asset result without numeric coercion', async () => {
    appendJournalRows(harness, [
      journalRow('2026-07-27', '餐飲', '銀行', '1000000000000000000.20', 'TWD', 'negative-1'),
      journalRow('2026-07-27', '銀行', '薪資收入', '1000000000000000000.10', 'TWD', 'negative-2'),
    ])

    const response = await postSnapshot(harness, 'accounts', 'accounts-negative-001')
    expect(response.records).toContainEqual(expect.objectContaining({
      id: stableAccountId(harness, '銀行'),
      balances: [{ amount: '-0.1', currency: 'TWD' }],
    }))
  })

  it('uses the same trimmed account identity for validation and balances', async () => {
    appendJournalRows(harness, [
      journalRow('2026-07-27', ' 現金 ', '薪資收入', '12.50', 'TWD', 'trimmed-account'),
    ])

    const response = await postSnapshot(harness, 'accounts', 'accounts-trimmed-001')
    expect(response.records).toContainEqual(expect.objectContaining({
      id: stableAccountId(harness, '現金'),
      balances: [{ amount: '12.5', currency: 'TWD' }],
    }))
  })

  it('accepts historical rows after their asset account is disabled', async () => {
    setAccountEnabled(harness, '現金', false)
    appendJournalRows(harness, [
      journalRow('2026-07-27', '餐飲', '現金', '25', 'TWD', 'disabled-history'),
    ])

    const accounts = await postSnapshot(harness, 'accounts', 'accounts-disabled-history')
    expect(accounts.records).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '現金' }),
    ]))
    for (const record of accounts.records as Array<Record<string, unknown>>) {
      expect(record).toMatchObject({
        completion: { sourceRowCount: 1, sourceLastRow: 2 },
      })
    }
    expect((await postSnapshot(harness, 'events', 'events-disabled-history')).records)
      .toEqual([expect.objectContaining({ id: 'disabled-history' })])
  })

  it('refuses duplicate enabled account names instead of emitting duplicate ids', async () => {
    const accounts = requiredSheet(harness, '會計科目')
    accounts.getRange(accounts.getLastRow() + 1, 1, 1, 5).setValues([
      ['現金', '資產', '重複', true, 999],
    ])

    expect(await postSnapshot(harness, 'accounts', 'accounts-duplicate-name')).toEqual({
      ok: false,
      error: 'duplicate account name: 現金',
    })
  })

  it('refuses a duplicate disabled name whose historical account type is ambiguous', async () => {
    const accounts = requiredSheet(harness, '會計科目')
    accounts.getRange(accounts.getLastRow() + 1, 1, 1, 5).setValues([
      ['現金', '支出', '停用重複', false, 999],
    ])

    expect(await postSnapshot(harness, 'events', 'events-duplicate-disabled-name')).toEqual({
      ok: false,
      error: 'duplicate account name: 現金',
    })
  })

  it('refuses a blank enabled account name instead of emitting an empty id', async () => {
    const accounts = requiredSheet(harness, '會計科目')
    accounts.getRange(accounts.getLastRow() + 1, 1, 1, 5).setValues([
      ['', '資產', '測試', true, 999],
    ])

    expect(await postSnapshot(harness, 'accounts', 'accounts-blank-name')).toEqual({
      ok: false,
      error: `enabled account name is required at row ${accounts.getLastRow()}`,
    })
  })

  it('refuses malformed decimal grouping instead of changing the amount', async () => {
    appendJournalRows(harness, [
      journalRow('2026-07-27', '餐飲', '現金', '1,2', 'TWD', 'bad-grouping'),
    ])

    expect(await postSnapshot(harness, 'events', 'events-bad-grouping')).toEqual({
      ok: false,
      error: 'invalid journal amount at row 2',
    })
  })

  it.each(['0', '-1.25'])('refuses non-positive source amount %s', async (amount) => {
    appendJournalRows(harness, [
      journalRow('2026-07-27', '餐飲', '現金', amount, 'TWD', `non-positive-${amount}`),
    ])

    expect(await postSnapshot(harness, 'events', `events-non-positive-${amount}`)).toEqual({
      ok: false,
      error: 'journal amount must be positive at row 2',
    })
  })

  it('rejects a continuation cursor that is not pinned to a revision', async () => {
    appendJournalRows(
      harness,
      Array.from({ length: 201 }, (_unused, index) =>
        journalRow('2026-07-27', '餐飲', '現金', '1', 'TWD', `unpinned-${index}`)),
    )

    expect(await postSnapshot(harness, 'events', 'events-unpinned-cursor', {
      cursor: '200',
    })).toEqual({
      ok: false,
      error: 'snapshot continuation requires snapshotRevision',
    })
  })

  it('refuses an unsupported interval instead of returning a misleading complete page', async () => {
    expect(await post(harness, {
      action: 'snapshot',
      scope: 'events',
      interval: { from: '2026-07-01', to: '2026-07-02' },
      contractVersion: CONTRACT_VERSION,
    }, 'events-interval')).toEqual({
      ok: false,
      error: 'snapshot interval is not supported',
    })
  })

  it('uses raw amount precision for balances and data revisions even when display is rounded', async () => {
    writeJournalRowsAt(harness, 2, [{
      ...journalRow('2026-07-27', '現金', '薪資收入', '1.2345', 'TWD', 'raw-precision'),
      金額: 1.2345,
    }])
    const journal = requiredSheet(harness, '日記帳')
    journal.getRange(2, 6).setNumberFormat('0.00')

    const first = await postSnapshot(harness, 'accounts', 'accounts-raw-precision-1')
    expect(first.records).toContainEqual(expect.objectContaining({
      id: stableAccountId(harness, '現金'),
      balances: [{ amount: '1.2345', currency: 'TWD' }],
    }))
    const oldRevision = String(first.snapshotRevision)

    journal.getRange(2, 6).setValues([[1.2346]])
    const changed = await postSnapshot(harness, 'events', 'events-raw-precision-2', {
      snapshotRevision: oldRevision,
    })
    expect(changed).toEqual({
      kind: 'revision-changed',
      book: 'personal',
      expected: oldRevision,
      actual: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
  })

  it('repeated account and event snapshots do not mutate sheets or script properties', async () => {
    appendJournalRows(harness, [
      journalRow('2026-07-27', '餐飲', '現金', '5.25', 'TWD', 'read-only-row'),
    ])
    harness.clearEvents()
    const sheetsBefore = spreadsheetSnapshot(harness)
    const propertiesBefore = harness.scriptPropertiesSnapshot()

    const accountsFirst = await postSnapshot(harness, 'accounts', 'read-only-accounts-1')
    const events = await postSnapshot(harness, 'events', 'read-only-events-1')
    const accountsSecond = await postSnapshot(harness, 'accounts', 'read-only-accounts-2')

    expect(accountsFirst.snapshotRevision).toBe(events.snapshotRevision)
    expect(accountsSecond).toEqual(accountsFirst)
    expect(spreadsheetSnapshot(harness)).toBe(sheetsBefore)
    expect(harness.scriptPropertiesSnapshot()).toEqual(propertiesBefore)
    expect(harness.events).toEqual([])
  })
})

type JsonResponse = Record<string, unknown>

async function post(
  harness: FakeGasHarness,
  payload: Record<string, unknown>,
  nonce: string,
): Promise<JsonResponse> {
  const envelope = await productionBuildEnvelope(
    secret,
    payload,
    Math.floor(fixedNow.getTime() / 1000),
    nonce,
  )
  return parseOutput(harness.doPost({ postData: { contents: JSON.stringify(envelope) } }))
}

function parseOutput(output: FakeTextOutput): JsonResponse {
  expect(output.getMimeType()).toBe('application/json')
  return JSON.parse(output.getContent()) as JsonResponse
}

function postSnapshot(
  harness: FakeGasHarness,
  scope: 'accounts' | 'events',
  nonce: string,
  continuation: { cursor?: string; snapshotRevision?: string } = {},
): Promise<JsonResponse> {
  return post(harness, {
    action: 'snapshot',
    scope,
    contractVersion: CONTRACT_VERSION,
    ...continuation,
  }, nonce)
}

function requiredSheet(harness: FakeGasHarness, name: string): FakeSheet {
  const sheet = harness.spreadsheet.getSheetByName(name)
  if (!sheet) throw new Error(`missing test sheet: ${name}`)
  return sheet
}

function setAccountEnabled(harness: FakeGasHarness, accountName: string, enabled: boolean): void {
  const accounts = requiredSheet(harness, '會計科目')
  const values = accounts.getRange(1, 1, accounts.getLastRow(), accounts.getLastColumn()).getValues()
  const nameColumn = values[0]!.indexOf('名稱')
  const enabledColumn = values[0]!.indexOf('啟用')
  const row = values.findIndex(valuesRow => valuesRow[nameColumn] === accountName)
  if (row < 1) throw new Error(`missing test account: ${accountName}`)
  accounts.getRange(row + 1, enabledColumn + 1).setValues([[enabled]])
}

function stableAccountId(harness: FakeGasHarness, accountName: string): string {
  const accounts = requiredSheet(harness, '會計科目')
  const values = accounts.getRange(1, 1, accounts.getLastRow(), accounts.getLastColumn()).getValues()
  const nameColumn = values[0]!.indexOf('名稱')
  const stableIdColumn = values[0]!.indexOf('stable_id')
  const row = values.find(valuesRow => valuesRow[nameColumn] === accountName)
  if (!row) throw new Error(`missing test account: ${accountName}`)
  return String(row[stableIdColumn] ?? '')
}

function journalRow(
  date: string,
  debitAccount: string,
  creditAccount: string,
  amount: string,
  currency: string,
  txnId: string,
): Record<string, unknown> {
  return {
    日期: date,
    時間: '12:34',
    類型: '測試',
    借方帳戶: debitAccount,
    貸方帳戶: creditAccount,
    金額: amount,
    幣別: currency,
    分類: '測試分類',
    交易對象: '測試對象',
    說明: '合成測試資料',
    結清狀態: '',
    沖銷txn_id: '',
    txn_id: txnId,
    來源: 'test-fixture',
    建立時間: `${date}T12:34:00+08:00`,
  }
}

function appendJournalRows(
  harness: FakeGasHarness,
  rows: Array<Record<string, unknown>>,
): void {
  const journal = requiredSheet(harness, '日記帳')
  const values = rows.map(row => journalHeaders.map(header => row[header] ?? ''))
  journal.getRange(
    journal.getLastRow() + 1,
    1,
    values.length,
    journalHeaders.length,
  ).setValues(values)
}

function writeJournalRowsAt(
  harness: FakeGasHarness,
  startRow: number,
  rows: Array<Record<string, unknown>>,
): void {
  const journal = requiredSheet(harness, '日記帳')
  const values = rows.map(row => journalHeaders.map(header => row[header] ?? ''))
  journal.getRange(startRow, 1, values.length, journalHeaders.length).setValues(values)
}

function spreadsheetSnapshot(harness: FakeGasHarness): string {
  return JSON.stringify(harness.spreadsheet.getSheets().map(sheet => ({
    name: sheet.getName(),
    values: sheet.getLastRow() === 0 || sheet.getLastColumn() === 0
      ? []
      : sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues(),
  })))
}
