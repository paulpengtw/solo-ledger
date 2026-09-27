import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildEnvelope } from '../functions/lib/envelope'
import { CONTRACT_VERSION } from '../src/generated/version'
import {
  loadGasFunctionsWithFakeGas,
  type FakeGasHarness,
  type FakeSheet,
} from './helpers/gas'

const secret = 'test-secret'
const fixedNow = new Date('2026-07-27T00:00:00.000Z')
const journalHeaders = [
  '日期', '時間', '類型', '借方帳戶', '貸方帳戶', '金額', '幣別', '分類',
  '交易對象', '說明', '結清狀態', '沖銷txn_id', 'txn_id', '來源', '建立時間',
]
const observationHeaders = ['observation_id', 'source_reference', 'content_digest']
const validObservationDigest = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

describe('stable identity', () => {
  let harness: FakeGasHarness

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(fixedNow)
    harness = loadGasFunctionsWithFakeGas()
  })

  it('persists stable account and source-observation identities and reports the capability', async () => {
    harness.setupSpreadsheet()

    const state = await post(harness, { action: 'integrationState' }, 'identity-state-001')
    expect(state.capabilities).toContain('stable-identity')

    const accounts = requiredSheet(harness, '會計科目')
    const accountValues = accounts
      .getRange(1, 1, accounts.getLastRow(), accounts.getLastColumn())
      .getValues()
    const accountHeaders = accountValues[0]!.map(String)
    const stableIdColumn = accountHeaders.indexOf('stable_id')
    expect(stableIdColumn).toBeGreaterThanOrEqual(0)
    const accountIds = accountValues.slice(1)
      .filter(row => String(row[0] ?? '').trim() !== '')
      .map(row => String(row[stableIdColumn] ?? '').trim())
    expect(accountIds.every(Boolean)).toBe(true)
    expect(new Set(accountIds).size).toBe(accountIds.length)

    const journal = requiredSheet(harness, '日記帳')
    journal.getRange(2, 1, 1, journalHeaders.length).setValues([[
      '2026-07-27', '12:34', '測試', '餐飲', '現金', '1', 'TWD', '測試分類',
      '測試對象', 'legacy row', '', '', '', 'test-fixture', '2026-07-27T12:34:00+08:00',
    ]])
    const observations = requiredSheet(harness, '來源觀察')
    observations.getRange(2, 1, 1, observationHeaders.length).setValues([[
      'observation:known-setup', 'test-fixture:row-1', validObservationDigest,
    ]])
    harness.setupSpreadsheet()

    expect(observations.getRange(2, 1, 1, observationHeaders.length).getValues()[0]).toEqual([
      'observation:known-setup', 'test-fixture:row-1', validObservationDigest,
    ])
    expect(journal.getRange(2, 13).getValues()[0]![0]).toBe('')
  })

  it('classifies a blank event identity as unidentified in a pinned lookup', async () => {
    harness.setupSpreadsheet()
    const journal = requiredSheet(harness, '日記帳')
    journal.getRange(2, 1, 1, journalHeaders.length).setValues([[
      '2026-07-27', '12:34', '測試', '餐飲', '現金', '1', 'TWD', '測試分類',
      '測試對象', 'legacy row', '', '', '', 'test-fixture', '2026-07-27T12:34:00+08:00',
    ]])

    const snapshot = await post(harness, {
      action: 'snapshot',
      scope: 'events',
    }, 'identity-lookup-snapshot')
    expect(snapshot.records).toEqual([
      expect.objectContaining({
        id: null,
        identity: { kind: 'unidentified', reason: 'blank-txn-id' },
        contentDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        repairReference: {
          scope: 'events',
          sheetRow: 2,
          contentDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      }),
    ])
  })

  it('refuses an automatic update target with a blank event identity', async () => {
    harness.setupSpreadsheet()
    const journal = requiredSheet(harness, '日記帳')
    journal.getRange(2, 1, 1, journalHeaders.length).setValues([[
      '2026-07-27', '12:34', '測試', '餐飲', '現金', '1', 'TWD', '測試分類',
      '測試對象', 'legacy row', '', '', '', 'test-fixture', '2026-07-27T12:34:00+08:00',
    ]])
    const before = journal.getRange(2, 1, 1, journal.getLastColumn()).getValues()[0]!

    const refused = await post(harness, {
      action: 'reverse_transaction',
      idempotencyKey: 'identity-automatic-update-refusal',
      txn_id: '',
      date: '2026-07-27',
    }, 'identity-automatic-update-refusal')
    expect(refused).toEqual({ ok: false, error: 'txn_id is required' })
    expect(journal.getRange(2, 1, 1, journal.getLastColumn()).getValues()[0]!).toEqual(before)
  })

  it('refuses a whitespace-only legacy txn_id as a settlement target without writing', async () => {
    harness.setupSpreadsheet()
    const journal = requiredSheet(harness, '日記帳')
    journal.getRange(2, 1, 1, journalHeaders.length).setValues([[
      '2026-07-27', '12:34', '收入', '應收帳款', '薪資收入', '100', 'TWD', '',
      '阿明', 'legacy whitespace id', '未結', '', '   ', 'test-fixture', '2026-07-27T12:34:00+08:00',
    ]])
    const before = journal.getRange(2, 1, 1, journal.getLastColumn()).getValues()[0]!

    const refused = await post(harness, {
      action: 'settle',
      idempotencyKey: 'identity-whitespace-settle',
      txn_id: '   ',
      account: '銀行',
      date: '2026-07-27',
    }, 'identity-whitespace-settle')
    expect(refused).toEqual({ ok: false, error: 'txn_id is required' })
    expect(journal.getLastRow()).toBe(2)
    expect(journal.getRange(2, 1, 1, journal.getLastColumn()).getValues()[0]!).toEqual(before)
  })

  it('refuses a whitespace-only legacy txn_id as a reversal target without writing', async () => {
    harness.setupSpreadsheet()
    const journal = requiredSheet(harness, '日記帳')
    journal.getRange(2, 1, 1, journalHeaders.length).setValues([[
      '2026-07-27', '12:34', '支出', '餐飲', '現金', '100', 'TWD', '餐飲',
      '阿明', 'legacy whitespace id', '', '', '   ', 'test-fixture', '2026-07-27T12:34:00+08:00',
    ]])
    const before = journal.getRange(2, 1, 1, journal.getLastColumn()).getValues()[0]!

    const refused = await post(harness, {
      action: 'reverse_transaction',
      idempotencyKey: 'identity-whitespace-reversal',
      txn_id: '   ',
      date: '2026-07-27',
    }, 'identity-whitespace-reversal')
    expect(refused).toEqual({ ok: false, error: 'txn_id is required' })
    expect(journal.getLastRow()).toBe(2)
    expect(journal.getRange(2, 1, 1, journal.getLastColumn()).getValues()[0]!).toEqual(before)
  })

  it('requires event adoption to write a UUID stable identity', async () => {
    harness.setupSpreadsheet()
    const journal = requiredSheet(harness, '日記帳')
    journal.getRange(2, 1, 1, journalHeaders.length).setValues([[
      '2026-07-27', '12:34', '測試', '餐飲', '現金', '1', 'TWD', '測試分類',
      '測試對象', 'legacy row', '', '', '', 'test-fixture', '2026-07-27T12:34:00+08:00',
    ]])
    const snapshot = await post(harness, { action: 'snapshot', scope: 'events' }, 'identity-invalid-event-id-snapshot')
    const refused = await post(harness, {
      action: 'adopt_identity',
      operationId: 'identity-invalid-event-id',
      expectedSnapshotRevision: String(snapshot.snapshotRevision),
      repairReference: (snapshot.records as Array<Record<string, unknown>>)[0]!.repairReference,
      stableId: 'event:legacy-001',
    }, 'identity-invalid-event-id')
    expect(refused).toEqual({ ok: false, error: 'stableId must be a UUID' })
    expect(journal.getRange(2, 13).getValues()[0]![0]).toBe('')
  })

  it('keeps source observations independent from journal rows', async () => {
    harness.setupSpreadsheet()
    const observationSheet = requiredSheet(harness, '來源觀察')
    observationSheet.getRange(2, 1, 2, observationHeaders.length).setValues([
      ['observation:one', 'bank:row-1', validObservationDigest],
      ['observation:two', 'bank:row-2', validObservationDigest],
    ])

    const observations = await post(harness, { action: 'snapshot', scope: 'observations' }, 'identity-non-observation-snapshot')
    expect(observations.records).toHaveLength(2)
  })

  it('does not identify or adopt an observation without immutable source evidence', async () => {
    harness.setupSpreadsheet()
    const observationSheet = requiredSheet(harness, '來源觀察')
    observationSheet.getRange(2, 1, 1, observationHeaders.length).setValues([[
      'observation:invalid-evidence', '', 'not-a-digest',
    ]])

    const snapshot = await post(harness, { action: 'snapshot', scope: 'observations' }, 'identity-invalid-observation-snapshot')
    const record = (snapshot.records as Array<Record<string, unknown>>)[0]!
    expect(record).toMatchObject({
      id: null,
      persistedId: 'observation:invalid-evidence',
      identity: { kind: 'unidentified', reason: 'invalid-observation-evidence' },
    })
    const lookup = await post(harness, {
      action: 'lookup',
      ids: ['observation:invalid-evidence'],
      snapshotRevision: String(snapshot.snapshotRevision),
    }, 'identity-invalid-observation-lookup')
    expect(lookup).toMatchObject({ kind: 'ok', records: [], missing: [], unidentified: ['observation:invalid-evidence'] })
    const before = observationSheet.getRange(2, 1, 1, observationHeaders.length).getValues()[0]!
    const adoption = await post(harness, {
      action: 'adopt_identity',
      operationId: 'identity-invalid-observation-adoption',
      expectedSnapshotRevision: String(snapshot.snapshotRevision),
      repairReference: record.repairReference,
      stableId: 'observation:invalid-adopted',
    }, 'identity-invalid-observation-adoption')
    expect(adoption).toMatchObject({ ok: false, kind: 'conflict', reason: 'invalid-observation-evidence' })
    expect(observationSheet.getRange(2, 1, 1, observationHeaders.length).getValues()[0]!).toEqual(before)
  })

  it('fails closed on duplicate stable identities within and across identity scopes', async () => {
    harness.setupSpreadsheet()
    const journal = requiredSheet(harness, '日記帳')
    const duplicateEventId = '00000000-0000-4000-8000-000000000302'
    journal.getRange(2, 1, 2, journalHeaders.length).setValues([
      [
        '2026-07-27', '12:34', '測試', '餐飲', '現金', '1', 'TWD', '測試分類',
        '測試對象', 'duplicate one', '', '', duplicateEventId, 'test-fixture', '2026-07-27T12:34:00+08:00',
      ],
      [
        '2026-07-27', '12:35', '測試', '餐飲', '現金', '2', 'TWD', '測試分類',
        '測試對象', 'duplicate two', '', '', duplicateEventId, 'test-fixture', '2026-07-27T12:35:00+08:00',
      ],
    ])
    const events = await post(harness, { action: 'snapshot', scope: 'events' }, 'identity-duplicate-scope-snapshot')
    expect(events).toEqual({
      kind: 'unavailable',
      book: 'personal',
      reason: 'stable-identity-duplicate-id',
    })
    const state = await post(harness, { action: 'integrationState' }, 'identity-duplicate-scope-state')
    expect(state.capabilities).toEqual(['complete-revisioned-reads'])

    const accounts = requiredSheet(harness, '會計科目')
    const accountHeaders = accounts.getRange(1, 1, 1, accounts.getLastColumn()).getValues()[0]!.map(String)
    const stableIdColumn = accountHeaders.indexOf('stable_id')
    const cashRow = accounts.getRange(1, 1, accounts.getLastRow(), accounts.getLastColumn())
      .getValues().findIndex(row => row[0] === '現金') + 1
    accounts.getRange(cashRow, stableIdColumn + 1).setValues([[duplicateEventId]])
    const observations = requiredSheet(harness, '來源觀察')
    observations.getRange(2, 1, 1, observationHeaders.length).setValues([[
      duplicateEventId, 'test-fixture:duplicate', validObservationDigest,
    ]])
    const accountSnapshot = await post(harness, { action: 'snapshot', scope: 'accounts' }, 'identity-duplicate-cross-scope-account')
    expect(accountSnapshot).toEqual({
      kind: 'unavailable',
      book: 'personal',
      reason: 'stable-identity-duplicate-id',
    })
    const observationsSnapshot = await post(harness, { action: 'snapshot', scope: 'observations' }, 'identity-duplicate-cross-scope-observations')
    expect(observationsSnapshot).toEqual({
      kind: 'unavailable',
      book: 'personal',
      reason: 'stable-identity-duplicate-id',
    })
    const eventsSnapshot = await post(harness, { action: 'snapshot', scope: 'events' }, 'identity-duplicate-cross-scope-events')
    expect(eventsSnapshot).toEqual({
      kind: 'unavailable',
      book: 'personal',
      reason: 'stable-identity-duplicate-id',
    })
  })

  it('rejects adoption when the requested identity already exists in another scope', async () => {
    harness.setupSpreadsheet()
    const collisionId = '00000000-0000-4000-8000-000000000304'
    const accounts = requiredSheet(harness, '會計科目')
    const accountValues = accounts.getRange(1, 1, accounts.getLastRow(), accounts.getLastColumn()).getValues()
    const accountHeaders = accountValues[0]!.map(String)
    const stableIdColumn = accountHeaders.indexOf('stable_id')
    const cashRow = accountValues.findIndex(row => row[0] === '現金') + 1
    accounts.getRange(cashRow, stableIdColumn + 1).setValues([[collisionId]])

    const journal = requiredSheet(harness, '日記帳')
    journal.getRange(2, 1, 1, journalHeaders.length).setValues([[
      '2026-07-27', '12:34', '測試', '餐飲', '現金', '1', 'TWD', '測試分類',
      '測試對象', 'cross-scope adoption', '', '', '', 'test-fixture', '2026-07-27T12:34:00+08:00',
    ]])
    const snapshot = await post(harness, { action: 'snapshot', scope: 'events' }, 'identity-cross-scope-adoption-snapshot')
    const reference = (snapshot.records as Array<Record<string, unknown>>)[0]!.repairReference
    const adoption = await post(harness, {
      action: 'adopt_identity',
      operationId: 'identity-cross-scope-adoption',
      expectedSnapshotRevision: String(snapshot.snapshotRevision),
      repairReference: reference,
      stableId: collisionId,
    }, 'identity-cross-scope-adoption')
    expect(adoption).toMatchObject({ ok: false, kind: 'conflict', reason: 'duplicate-stable-id' })
    expect(journal.getRange(2, 13).getValues()[0]![0]).toBe('')
  })

  it('keeps account and event snapshots usable while an observation schema is unavailable', async () => {
    harness.setupSpreadsheet()
    const observationSheet = requiredSheet(harness, '來源觀察')
    observationSheet.getRange(1, 1, 1, 1).setValues([['malformed']])

    const state = await post(harness, { action: 'integrationState' }, 'identity-observation-schema-state')
    expect(state.capabilities).toEqual(['complete-revisioned-reads'])
    const accounts = await post(harness, { action: 'snapshot', scope: 'accounts' }, 'identity-observation-schema-accounts')
    expect(accounts).toMatchObject({ scope: 'accounts', records: expect.any(Array) })
    const events = await post(harness, { action: 'snapshot', scope: 'events' }, 'identity-observation-schema-events')
    expect(events).toMatchObject({ scope: 'events', records: expect.any(Array) })
    const observations = await post(harness, { action: 'snapshot', scope: 'observations' }, 'identity-observation-schema-observations')
    expect(observations).toEqual({
      kind: 'unavailable',
      book: 'personal',
      reason: 'stable-identity-schema-unavailable',
    })
    const lookup = await post(harness, {
      action: 'lookup', ids: ['account:現金'], snapshotRevision: String(accounts.snapshotRevision),
    }, 'identity-observation-schema-lookup')
    expect(lookup).toEqual({
      kind: 'unavailable',
      book: 'personal',
      reason: 'stable-identity-schema-unavailable',
    })
  })

  it('suppresses stable identity until the aliases metadata header is available', async () => {
    harness.setupSpreadsheet()
    const accounts = requiredSheet(harness, '會計科目')
    const headers = accounts.getRange(1, 1, 1, accounts.getLastColumn()).getValues()[0]!.map(String)
    const aliasesColumn = headers.indexOf('aliases')
    accounts.getRange(1, aliasesColumn + 1).setValues([['legacy_aliases']])

    const state = await post(harness, { action: 'integrationState' }, 'identity-alias-schema-state')
    expect(state.capabilities).toEqual(['complete-revisioned-reads'])
  })

  it('looks up stable account and source-observation identities at one revision', async () => {
    harness.setupSpreadsheet()
    const accounts = requiredSheet(harness, '會計科目')
    const accountValues = accounts.getRange(1, 1, accounts.getLastRow(), accounts.getLastColumn()).getValues()
    const stableIdColumn = accountValues[0]!.map(String).indexOf('stable_id')
    const accountRow = accountValues.find(row => row[0] === '現金')!
    const accountId = String(accountRow[stableIdColumn]!)
    const journal = requiredSheet(harness, '日記帳')
    journal.getRange(2, 1, 1, journalHeaders.length).setValues([[
      '2026-07-27', '12:34', '測試', '餐飲', '現金', '1', 'TWD', '測試分類',
      '測試對象', 'source observation', '', '', '', 'import', '2026-07-27T12:34:00+08:00',
    ]])
    const observationSheet = requiredSheet(harness, '來源觀察')
    observationSheet.getRange(2, 1, 1, observationHeaders.length).setValues([[
      'observation:known-lookup', 'import:file-1:row-2', validObservationDigest,
    ]])
    harness.setupSpreadsheet()

    const observations = await post(harness, { action: 'snapshot', scope: 'observations' }, 'identity-observation-snapshot')
    const observationId = String((observations.records as Array<Record<string, unknown>>)[0]!.id)
    const accountSnapshot = await post(harness, { action: 'snapshot', scope: 'accounts' }, 'identity-account-snapshot')
    const revision = String(accountSnapshot.snapshotRevision)
    const accountsLookup = await post(harness, {
      action: 'lookup', ids: [accountId], snapshotRevision: revision,
    }, 'identity-account-lookup')
    const observationsLookup = await post(harness, {
      action: 'lookup', ids: [observationId], snapshotRevision: revision,
    }, 'identity-observation-lookup')
    expect(accountsLookup).toMatchObject({ kind: 'ok', missing: [], unidentified: [] })
    expect(accountsLookup.records).toEqual([
      expect.objectContaining({ stableId: accountId, identity: { kind: 'identified', stableId: accountId } }),
    ])
    expect(observationsLookup).toMatchObject({ kind: 'ok', missing: [], unidentified: [] })
    expect(observationsLookup.records).toEqual([
      expect.objectContaining({ id: observationId, sourceReference: 'import:file-1:row-2' }),
    ])
  })

  it('looks up requested identities across scopes and classifies a legacy account alias', async () => {
    harness.setupSpreadsheet()
    const accounts = requiredSheet(harness, '會計科目')
    const accountValues = accounts.getRange(1, 1, accounts.getLastRow(), accounts.getLastColumn()).getValues()
    const accountHeaders = accountValues[0]!.map(String)
    const stableIdColumn = accountHeaders.indexOf('stable_id')
    const cashRow = accountValues.findIndex(row => row[0] === '現金') + 1
    accounts.getRange(cashRow, stableIdColumn + 1).setValues([['']])

    const journal = requiredSheet(harness, '日記帳')
    const eventId = '00000000-0000-4000-8000-000000000301'
    journal.getRange(2, 1, 1, journalHeaders.length).setValues([[
      '2026-07-27', '12:34', '測試', '餐飲', '現金', '1', 'TWD', '測試分類',
      '測試對象', 'cross-scope lookup', '', '', eventId, 'test-fixture', '2026-07-27T12:34:00+08:00',
    ]])
    const observations = requiredSheet(harness, '來源觀察')
    const observationId = 'observation:lookup-cross-scope'
    observations.getRange(2, 1, 1, observationHeaders.length).setValues([[
      observationId, 'test-fixture:cross-scope', validObservationDigest,
    ]])

    const snapshot = await post(harness, { action: 'snapshot', scope: 'events' }, 'identity-unscoped-lookup-snapshot')
    const lookup = await post(harness, {
      action: 'lookup',
      ids: ['account:現金', eventId, observationId],
      snapshotRevision: String(snapshot.snapshotRevision),
    }, 'identity-unscoped-lookup')

    expect(lookup).toMatchObject({
      kind: 'ok',
      missing: [],
      unidentified: ['account:現金'],
    })
    expect(lookup.records).toEqual([
      expect.objectContaining({ id: eventId }),
      expect.objectContaining({ id: observationId }),
    ])
    expect((lookup.records as Array<Record<string, unknown>>).some(record => record.id === 'account:現金')).toBe(false)
  })

  it('pins unscoped lookup revisions to disabled account identity and alias metadata', async () => {
    harness.setupSpreadsheet()
    const accounts = requiredSheet(harness, '會計科目')
    const values = accounts.getRange(1, 1, accounts.getLastRow(), accounts.getLastColumn()).getValues()
    const headers = values[0]!.map(String)
    const stableIdColumn = headers.indexOf('stable_id')
    const aliasesColumn = headers.indexOf('aliases')
    const enabledColumn = headers.indexOf('啟用')
    const disabledRow = values.findIndex(row => row[0] === '悠遊卡') + 1
    const stableId = String(values[disabledRow - 1]![stableIdColumn])
    const lookupId = String(values.find(row => row[0] === '現金')![stableIdColumn])
    accounts.getRange(disabledRow, enabledColumn + 1).setValues([[false]])

    const before = await post(harness, { action: 'snapshot', scope: 'accounts' }, 'identity-disabled-revision-before')
    expect((before.records as Array<Record<string, unknown>>).some(record => record.stableId === stableId)).toBe(false)
    accounts.getRange(disabledRow, stableIdColumn + 1).setValues([['account:disabled-revised']])
    accounts.getRange(disabledRow, aliasesColumn + 1).setValues([['["舊悠遊卡"]']])

    const lookup = await post(harness, {
      action: 'lookup',
      ids: [lookupId],
      snapshotRevision: String(before.snapshotRevision),
    }, 'identity-disabled-revision-after')
    expect(lookup).toMatchObject({
      kind: 'revision-changed',
      expected: before.snapshotRevision,
      actual: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(lookup.actual).not.toBe(before.snapshotRevision)
  })

  it('adopts a reviewed account identity without changing its source row', async () => {
    harness.setupSpreadsheet()
    const accounts = requiredSheet(harness, '會計科目')
    const headers = accounts.getRange(1, 1, 1, accounts.getLastColumn()).getValues()[0]!.map(String)
    const stableIdColumn = headers.indexOf('stable_id')
    const accountRow = accounts.getRange(1, 1, accounts.getLastRow(), accounts.getLastColumn())
      .getValues().findIndex(row => row[0] === '現金') + 1
    const before = accounts.getRange(accountRow, 1, 1, accounts.getLastColumn()).getValues()[0]!
    accounts.getRange(accountRow, stableIdColumn + 1).setValues([['']])

    const snapshot = await post(harness, { action: 'snapshot', scope: 'accounts' }, 'identity-account-adopt-snapshot')
    const revision = String(snapshot.snapshotRevision)
    const reference = (snapshot.records as Array<Record<string, unknown>>)
      .find(record => record.name === '現金')!.repairReference
    const lookup = await post(harness, {
      action: 'lookup', ids: ['account:現金'], snapshotRevision: revision,
    }, 'identity-account-adopt-lookup')
    expect(lookup).toMatchObject({ kind: 'ok', missing: [], unidentified: ['account:現金'] })

    const adopted = await post(harness, {
      action: 'adopt_identity',
      operationId: 'identity-account-adoption-001',
      expectedSnapshotRevision: revision,
      repairReference: reference,
      stableId: 'account:cash-001',
    }, 'identity-account-adoption-001')
    expect(adopted).toMatchObject({
      ok: true,
      scope: 'accounts',
      stableId: 'account:cash-001',
      changedField: 'stable_id',
    })
    const after = accounts.getRange(accountRow, 1, 1, accounts.getLastColumn()).getValues()[0]!
    expect(after).toEqual(before.map((value, index) =>
      index === stableIdColumn ? 'account:cash-001' : value))
  })

  it('rejects adoption that collides with another blank account legacy identity', async () => {
    harness.setupSpreadsheet()
    const accounts = requiredSheet(harness, '會計科目')
    const values = accounts.getRange(1, 1, accounts.getLastRow(), accounts.getLastColumn()).getValues()
    const headers = values[0]!.map(String)
    const stableIdColumn = headers.indexOf('stable_id')
    const cashRow = values.findIndex(row => row[0] === '現金') + 1
    const bankRow = values.findIndex(row => row[0] === '銀行') + 1
    accounts.getRange(cashRow, stableIdColumn + 1).setValues([['']])
    accounts.getRange(bankRow, stableIdColumn + 1).setValues([['']])

    const snapshot = await post(harness, { action: 'snapshot', scope: 'accounts' }, 'identity-legacy-collision-snapshot')
    const reference = (snapshot.records as Array<Record<string, unknown>>)
      .find(record => record.name === '銀行')!.repairReference
    const before = accounts.getRange(bankRow, 1, 1, accounts.getLastColumn()).getValues()[0]!

    const refused = await post(harness, {
      action: 'adopt_identity',
      operationId: 'identity-legacy-collision-adoption',
      expectedSnapshotRevision: String(snapshot.snapshotRevision),
      repairReference: reference,
      stableId: 'account:現金',
    }, 'identity-legacy-collision-adoption')
    expect(refused).toMatchObject({
      ok: false,
      kind: 'conflict',
      reason: 'duplicate-stable-id',
    })
    expect(accounts.getRange(bankRow, 1, 1, accounts.getLastColumn()).getValues()[0]!).toEqual(before)
  })

  it('leaves legacy blank account and observation identities for explicit repair', async () => {
    harness.setupSpreadsheet()
    const accounts = requiredSheet(harness, '會計科目')
    const accountHeaders = accounts.getRange(1, 1, 1, accounts.getLastColumn()).getValues()[0]!.map(String)
    const stableIdColumn = accountHeaders.indexOf('stable_id')
    const accountRow = accounts.getRange(1, 1, accounts.getLastRow(), accounts.getLastColumn())
      .getValues().findIndex(row => row[0] === '現金') + 1
    accounts.getRange(accountRow, stableIdColumn + 1).setValues([['']])
    const journal = requiredSheet(harness, '日記帳')
    journal.getRange(2, 1, 1, journalHeaders.length).setValues([[
      '2026-07-27', '12:34', '測試', '餐飲', '現金', '1', 'TWD', '測試分類',
      '測試對象', 'legacy source row', '', '', '', 'import', '2026-07-27T12:34:00+08:00',
    ]])
    const observationSheet = requiredSheet(harness, '來源觀察')
    observationSheet.getRange(2, 1, 1, observationHeaders.length).setValues([[
      '', 'legacy-source:row-1', validObservationDigest,
    ]])
    harness.setupSpreadsheet()

    expect(accounts.getRange(accountRow, stableIdColumn + 1).getValues()[0]![0]).toBe('')
    expect(observationSheet.getRange(2, 1).getValues()[0]![0]).toBe('')

    const accountSnapshot = await post(harness, { action: 'snapshot', scope: 'accounts' }, 'identity-legacy-account-snapshot')
    const accountRevision = String(accountSnapshot.snapshotRevision)
    const accountLookup = await post(harness, {
      action: 'lookup', ids: ['account:現金'], snapshotRevision: accountRevision,
    }, 'identity-legacy-account-lookup')
    expect(accountLookup).toMatchObject({ kind: 'ok', missing: [], unidentified: ['account:現金'] })
    expect(accountLookup.records).toEqual([])

    const observationSnapshot = await post(harness, { action: 'snapshot', scope: 'observations' }, 'identity-legacy-observation-snapshot')
    const observationRecord = (observationSnapshot.records as Array<Record<string, unknown>>)[0]!
    expect(observationRecord).toMatchObject({
      id: null,
      identity: { kind: 'unidentified', reason: 'blank-observation-id' },
    })
    const before = observationSheet.getRange(2, 1, 1, observationHeaders.length).getValues()[0]!
    const adopted = await post(harness, {
      action: 'adopt_identity',
      operationId: 'identity-observation-adoption-001',
      expectedSnapshotRevision: String(observationSnapshot.snapshotRevision),
      repairReference: observationRecord.repairReference,
      stableId: 'observation:legacy-001',
    }, 'identity-observation-adoption-001')
    expect(adopted).toMatchObject({ ok: true, scope: 'observations', stableId: 'observation:legacy-001' })
    const after = observationSheet.getRange(2, 1, 1, observationHeaders.length).getValues()[0]!
    expect(after).toEqual(before.map((value, index) =>
      index === 0 ? 'observation:legacy-001' : value))
  })

  it('adopts a reviewed identity while leaving every original source cell unchanged', async () => {
    harness.setupSpreadsheet()
    const journal = requiredSheet(harness, '日記帳')
    journal.getRange(2, 1, 1, journalHeaders.length).setValues([[
      '2026-07-27', '12:34', '測試', '餐飲', '現金', '1', 'TWD', '測試分類',
      '測試對象', 'legacy row', '', '', '', 'test-fixture', '2026-07-27T12:34:00+08:00',
    ]])

    const snapshot = await post(harness, {
      action: 'snapshot',
      scope: 'events',
    }, 'identity-adopt-snapshot')
    const revision = String(snapshot.snapshotRevision)
    const repairReference = (snapshot.records as Array<Record<string, unknown>>)[0]!.repairReference
    const before = journal.getRange(2, 1, 1, journal.getLastColumn()).getValues()[0]!

    const adopted = await post(harness, {
      action: 'adopt_identity',
      operationId: 'identity-adoption-001',
      expectedSnapshotRevision: revision,
      repairReference,
      stableId: '00000000-0000-4000-8000-000000000201',
    }, 'identity-adoption-001')
    expect(adopted).toMatchObject({
      ok: true,
      operationId: 'identity-adoption-001',
      stableId: '00000000-0000-4000-8000-000000000201',
      sheetRow: 2,
    })
    const after = journal.getRange(2, 1, 1, journal.getLastColumn()).getValues()[0]!
    expect(after).toEqual(before.map((value, index) =>
      index === 12 ? '00000000-0000-4000-8000-000000000201' : value))

    const events = await post(harness, {
      action: 'snapshot',
      scope: 'events',
    }, 'identity-adopt-events')
    expect(events.records).toEqual([
      expect.objectContaining({
        id: '00000000-0000-4000-8000-000000000201',
        identity: { kind: 'identified', txnId: '00000000-0000-4000-8000-000000000201' },
      }),
    ])
  })

  it('keeps an identified account id stable when its display name is renamed', async () => {
    harness.setupSpreadsheet()
    const accounts = requiredSheet(harness, '會計科目')
    const values = accounts.getRange(1, 1, accounts.getLastRow(), accounts.getLastColumn()).getValues()
    const headers = values[0]!.map(String)
    const stableIdColumn = headers.indexOf('stable_id')
    const nameColumn = headers.indexOf('名稱')
    const accountRow = values.findIndex(row => row[nameColumn] === '現金') + 1
    const stableId = String(values[accountRow - 1]![stableIdColumn])
    accounts.getRange(accountRow, nameColumn + 1).setValues([['現金改名']])

    const snapshot = await post(harness, { action: 'snapshot', scope: 'accounts' }, 'identity-account-rename')
    const renamed = (snapshot.records as Array<Record<string, unknown>>).find(record => record.name === '現金改名')
    expect(renamed).toMatchObject({ id: stableId, stableId, identity: { kind: 'identified', stableId } })
  })

  it('resolves historical journal names through strict account aliases after a rename', async () => {
    harness.setupSpreadsheet()
    const accounts = requiredSheet(harness, '會計科目')
    const values = accounts.getRange(1, 1, accounts.getLastRow(), accounts.getLastColumn()).getValues()
    const headers = values[0]!.map(String)
    const stableIdColumn = headers.indexOf('stable_id')
    const aliasesColumn = headers.indexOf('aliases')
    const nameColumn = headers.indexOf('名稱')
    const accountRow = values.findIndex(row => row[nameColumn] === '現金') + 1
    const stableId = String(values[accountRow - 1]![stableIdColumn])
    accounts.getRange(accountRow, aliasesColumn + 1).setValues([['["舊現金"]']])
    accounts.getRange(accountRow, nameColumn + 1).setValues([['現金改名']])

    const journal = requiredSheet(harness, '日記帳')
    journal.getRange(2, 1, 1, journalHeaders.length).setValues([[
      '2026-07-27', '12:34', '測試', '舊現金', '薪資收入', '12', 'TWD', '測試分類',
      '測試對象', 'historical alias', '', '', '00000000-0000-4000-8000-000000000303',
      'test-fixture', '2026-07-27T12:34:00+08:00',
    ]])

    const snapshot = await post(harness, { action: 'snapshot', scope: 'accounts' }, 'identity-account-alias-snapshot')
    const renamed = (snapshot.records as Array<Record<string, unknown>>).find(record => record.name === '現金改名')!
    expect(renamed).toMatchObject({
      id: stableId,
      stableId,
      aliases: ['舊現金'],
      balances: [{ amount: '12', currency: 'TWD' }],
    })
  })

  it('keeps a renamed disabled account readable for history without enabling new writes', async () => {
    harness.setupSpreadsheet()
    const accounts = requiredSheet(harness, '會計科目')
    const values = accounts.getRange(1, 1, accounts.getLastRow(), accounts.getLastColumn()).getValues()
    const headers = values[0]!.map(String)
    const aliasesColumn = headers.indexOf('aliases')
    const nameColumn = headers.indexOf('名稱')
    const enabledColumn = headers.indexOf('啟用')
    const accountRow = values.findIndex(row => row[nameColumn] === '現金') + 1
    accounts.getRange(accountRow, aliasesColumn + 1).setValues([['["舊現金"]']])
    accounts.getRange(accountRow, nameColumn + 1).setValues([['現金改名']])
    accounts.getRange(accountRow, enabledColumn + 1).setValues([[false]])

    const journal = requiredSheet(harness, '日記帳')
    journal.getRange(2, 1, 1, journalHeaders.length).setValues([[
      '2026-07-27', '12:34', '測試', '舊現金', '薪資收入', '12', 'TWD', '測試分類',
      '測試對象', 'disabled historical alias', '', '', '00000000-0000-4000-8000-000000000305',
      'test-fixture', '2026-07-27T12:34:00+08:00',
    ]])

    const events = await post(harness, { action: 'snapshot', scope: 'events' }, 'identity-disabled-alias-events')
    expect(events.records).toEqual([expect.objectContaining({ debitAccount: '舊現金' })])
    const refused = await post(harness, {
      action: 'create_transaction',
      idempotencyKey: 'identity-disabled-alias-write',
      transaction: {
        type: '支出',
        date: '2026-07-28',
        amount: '1',
        account: '舊現金',
        category: '餐飲',
        payee: 'test',
        currency: 'TWD',
        description: 'must remain disabled',
      },
    }, 'identity-disabled-alias-write')
    expect(refused).toEqual({ ok: false, error: 'unknown or disabled account: 舊現金' })
  })

  it('fails closed when an identified identity collides with an unidentified legacy alias', async () => {
    harness.setupSpreadsheet()
    const accounts = requiredSheet(harness, '會計科目')
    const values = accounts.getRange(1, 1, accounts.getLastRow(), accounts.getLastColumn()).getValues()
    const headers = values[0]!.map(String)
    const stableIdColumn = headers.indexOf('stable_id')
    const cashRow = values.findIndex(row => row[0] === '現金') + 1
    const bankRow = values.findIndex(row => row[0] === '銀行') + 1
    accounts.getRange(cashRow, stableIdColumn + 1).setValues([['']])
    accounts.getRange(bankRow, stableIdColumn + 1).setValues([['account:現金']])

    const snapshot = await post(harness, { action: 'snapshot', scope: 'accounts' }, 'identity-ambiguous-lookup-snapshot')
    const lookup = await post(harness, {
      action: 'lookup',
      ids: ['account:現金'],
      snapshotRevision: String(snapshot.snapshotRevision),
    }, 'identity-ambiguous-lookup')
    expect(lookup).toEqual({
      kind: 'unavailable',
      book: 'personal',
      reason: 'stable-identity-ambiguous-id',
    })
  })

  it('rejects ambiguous account aliases instead of guessing a journal owner', async () => {
    harness.setupSpreadsheet()
    const accounts = requiredSheet(harness, '會計科目')
    const values = accounts.getRange(1, 1, accounts.getLastRow(), accounts.getLastColumn()).getValues()
    const headers = values[0]!.map(String)
    const aliasesColumn = headers.indexOf('aliases')
    const cashRow = values.findIndex(row => row[0] === '現金') + 1
    const bankRow = values.findIndex(row => row[0] === '銀行') + 1
    accounts.getRange(cashRow, aliasesColumn + 1).setValues([['["舊帳戶"]']])
    accounts.getRange(bankRow, aliasesColumn + 1).setValues([['["舊帳戶"]']])

    const snapshot = await post(harness, { action: 'snapshot', scope: 'accounts' }, 'identity-account-alias-ambiguous')
    expect(snapshot).toEqual({ ok: false, error: 'ambiguous account alias: 舊帳戶' })
  })

  it('computes the event digest from resolved headers after journal columns are reordered', async () => {
    harness.setupSpreadsheet()
    const journal = requiredSheet(harness, '日記帳')
    const row = [
      '2026-07-27', '12:34', '測試', '餐飲', '現金', '1', 'TWD', '測試分類',
      '測試對象', 'legacy row', '', '', '', 'test-fixture', '2026-07-27T12:34:00+08:00',
    ]
    journal.getRange(2, 1, 1, journalHeaders.length).setValues([row])
    const reorderedHeaders = [...journalHeaders].reverse()
    const byHeader = Object.fromEntries(journalHeaders.map((header, index) => [header, row[index]]))
    const reorderedRow = reorderedHeaders.map(header => byHeader[header])
    journal.getRange(1, 1, 2, journalHeaders.length).setValues([reorderedHeaders, reorderedRow])
    const before = await post(harness, { action: 'snapshot', scope: 'events' }, 'identity-header-order-before')
    const repairReference = (before.records as Array<Record<string, unknown>>)[0]!.repairReference
    const adopted = await post(harness, {
      action: 'adopt_identity',
      operationId: 'identity-header-order-adoption',
      expectedSnapshotRevision: String(before.snapshotRevision),
      repairReference,
      stableId: '00000000-0000-4000-8000-000000000211',
    }, 'identity-header-order-adoption')
    expect(adopted).toMatchObject({ ok: true, stableId: '00000000-0000-4000-8000-000000000211' })
    const after = await post(harness, { action: 'snapshot', scope: 'events' }, 'identity-header-order-after')
    expect((after.records as Array<Record<string, unknown>>)[0]!.contentDigest)
      .toBe((before.records as Array<Record<string, unknown>>)[0]!.contentDigest)
  })

  it('accepts only the canonical adoption action and payload fields', async () => {
    harness.setupSpreadsheet()
    const journal = requiredSheet(harness, '日記帳')
    journal.getRange(2, 1, 1, journalHeaders.length).setValues([[
      '2026-07-27', '12:34', '測試', '餐飲', '現金', '1', 'TWD', '測試分類',
      '測試對象', 'legacy row', '', '', '', 'test-fixture', '2026-07-27T12:34:00+08:00',
    ]])
    const snapshot = await post(harness, { action: 'snapshot', scope: 'events' }, 'identity-canonical-snapshot')
    const reference = (snapshot.records as Array<Record<string, unknown>>)[0]!.repairReference
    const aliasAction = await post(harness, {
      action: 'adopt_stable_identity',
      operationId: 'identity-canonical-alias-action',
      expectedSnapshotRevision: String(snapshot.snapshotRevision),
      repairReference: reference,
      stableId: '00000000-0000-4000-8000-000000000208',
    }, 'identity-canonical-alias-action')
    expect(aliasAction).toEqual({ ok: false, error: 'unsupported action: adopt_stable_identity' })

    const aliasField = await post(harness, {
      action: 'adopt_identity',
      idempotencyKey: 'identity-canonical-alias-field',
      expectedSnapshotRevision: String(snapshot.snapshotRevision),
      repairReference: reference,
      stableId: '00000000-0000-4000-8000-000000000209',
    }, 'identity-canonical-alias-field')
    expect(aliasField).toEqual({ ok: false, error: 'operationId is required' })
  })

  it('durably replays identical adoption and conflicts on changed operation content', async () => {
    harness.setupSpreadsheet()
    const journal = requiredSheet(harness, '日記帳')
    journal.getRange(2, 1, 1, journalHeaders.length).setValues([[
      '2026-07-27', '12:34', '測試', '餐飲', '現金', '1', 'TWD', '測試分類',
      '測試對象', 'legacy row', '', '', '', 'test-fixture', '2026-07-27T12:34:00+08:00',
    ]])
    const snapshot = await post(harness, { action: 'snapshot', scope: 'events' }, 'identity-replay-snapshot')
    const revision = String(snapshot.snapshotRevision)
    const reference = (snapshot.records as Array<Record<string, unknown>>)[0]!.repairReference
    const request = {
      action: 'adopt_identity',
      operationId: 'identity-adoption-replay',
      expectedSnapshotRevision: revision,
      repairReference: reference,
      stableId: '00000000-0000-4000-8000-000000000202',
    }

    const first = await post(harness, request, 'identity-replay-first')
    const second = await post(harness, request, 'identity-replay-second')
    expect(second).toEqual({ ...first, already: true })

    const changed = await post(harness, {
      ...request,
      stableId: '00000000-0000-4000-8000-000000000203',
    }, 'identity-replay-changed')
    expect(changed).toMatchObject({
      ok: false,
      kind: 'conflict',
      operationId: 'identity-adoption-replay',
      reason: 'operation-content-changed',
    })
    expect(journal.getRange(2, 13).getValues()[0]![0]).toBe('00000000-0000-4000-8000-000000000202')
  })

  it('replays a pending adoption after the identity write initially fails', async () => {
    harness.setupSpreadsheet()
    const journal = requiredSheet(harness, '日記帳')
    journal.getRange(2, 1, 1, journalHeaders.length).setValues([[
      '2026-07-27', '12:34', '測試', '餐飲', '現金', '1', 'TWD', '測試分類',
      '測試對象', 'legacy row', '', '', '', 'test-fixture', '2026-07-27T12:34:00+08:00',
    ]])
    const snapshot = await post(harness, { action: 'snapshot', scope: 'events' }, 'identity-pending-snapshot')
    const request = {
      action: 'adopt_identity',
      operationId: 'identity-pending-replay',
      expectedSnapshotRevision: String(snapshot.snapshotRevision),
      repairReference: (snapshot.records as Array<Record<string, unknown>>)[0]!.repairReference,
      stableId: '00000000-0000-4000-8000-000000000210',
    }
    journal.failNextSetValuesInColumn(13)
    const failed = await post(harness, request, 'identity-pending-first')
    expect(failed).toEqual({ ok: false, error: 'simulated write failure' })
    expect(journal.getRange(2, 13).getValues()[0]![0]).toBe('')

    const replayed = await post(harness, request, 'identity-pending-second')
    expect(replayed).toMatchObject({ ok: true, operationId: request.operationId, stableId: request.stableId })
    expect(journal.getRange(2, 13).getValues()[0]![0]).toBe(request.stableId)
  })

  it('refuses stale revisions and changed target content before writing identity metadata', async () => {
    harness.setupSpreadsheet()
    const journal = requiredSheet(harness, '日記帳')
    journal.getRange(2, 1, 1, journalHeaders.length).setValues([[
      '2026-07-27', '12:34', '測試', '餐飲', '現金', '1', 'TWD', '測試分類',
      '測試對象', 'legacy row', '', '', '', 'test-fixture', '2026-07-27T12:34:00+08:00',
    ]])
    const snapshot = await post(harness, { action: 'snapshot', scope: 'events' }, 'identity-conflict-snapshot')
    const revision = String(snapshot.snapshotRevision)
    const reference = (snapshot.records as Array<Record<string, unknown>>)[0]!.repairReference as Record<string, unknown>

    journal.getRange(2, 10).setValues([['changed after review']])
    const stale = await post(harness, {
      action: 'adopt_identity',
      operationId: 'identity-adoption-stale',
      expectedSnapshotRevision: revision,
      repairReference: reference,
      stableId: '00000000-0000-4000-8000-000000000204',
    }, 'identity-adoption-stale')
    expect(stale).toMatchObject({ ok: false, kind: 'conflict', reason: 'revision-changed' })
    expect(journal.getRange(2, 13).getValues()[0]![0]).toBe('')

    const current = await post(harness, { action: 'snapshot', scope: 'events' }, 'identity-conflict-current')
    const currentRevision = String(current.snapshotRevision)
    const wrongReference = {
      ...((current.records as Array<Record<string, unknown>>)[0]!.repairReference as Record<string, unknown>),
      contentDigest: '0'.repeat(64),
    }
    const changed = await post(harness, {
      action: 'adopt_identity',
      operationId: 'identity-adoption-content',
      expectedSnapshotRevision: currentRevision,
      repairReference: wrongReference,
      stableId: '00000000-0000-4000-8000-000000000205',
    }, 'identity-adoption-content')
    expect(changed).toMatchObject({ ok: false, kind: 'conflict', reason: 'content-changed' })
    expect(journal.getRange(2, 13).getValues()[0]![0]).toBe('')
  })

  it('rejects duplicate and ambiguous stable identity targets', async () => {
    harness.setupSpreadsheet()
    const journal = requiredSheet(harness, '日記帳')
    journal.getRange(2, 1, 2, journalHeaders.length).setValues([
      [
        '2026-07-27', '12:34', '測試', '餐飲', '現金', '1', 'TWD', '測試分類',
        '測試對象', 'legacy', '', '', '00000000-0000-4000-8000-000000000206', 'test-fixture', '2026-07-27T12:34:00+08:00',
      ],
      [
        '2026-07-27', '12:34', '測試', '餐飲', '現金', '1', 'TWD', '測試分類',
        '測試對象', 'legacy', '', '', '', 'test-fixture', '2026-07-27T12:34:00+08:00',
      ],
    ])
    const snapshot = await post(harness, { action: 'snapshot', scope: 'events' }, 'identity-duplicate-snapshot')
    const revision = String(snapshot.snapshotRevision)
    const reference = (snapshot.records as Array<Record<string, unknown>>)[1]!.repairReference as Record<string, unknown>
    const duplicate = await post(harness, {
      action: 'adopt_identity',
      operationId: 'identity-adoption-duplicate',
      expectedSnapshotRevision: revision,
      repairReference: reference,
      stableId: '00000000-0000-4000-8000-000000000206',
    }, 'identity-adoption-duplicate')
    expect(duplicate).toMatchObject({ ok: false, kind: 'conflict', reason: 'duplicate-stable-id' })
    expect(journal.getRange(3, 13).getValues()[0]![0]).toBe('')

    const ambiguousReference = {
      scope: 'events',
      contentDigest: reference.contentDigest,
    }
    const ambiguous = await post(harness, {
      action: 'adopt_identity',
      operationId: 'identity-adoption-ambiguous',
      expectedSnapshotRevision: revision,
      repairReference: ambiguousReference,
      stableId: '00000000-0000-4000-8000-000000000207',
    }, 'identity-adoption-ambiguous')
    expect(ambiguous).toMatchObject({ ok: false, kind: 'conflict', reason: 'ambiguous-target' })
    expect(journal.getRange(3, 13).getValues()[0]![0]).toBe('')
  })
})

async function post(
  harness: FakeGasHarness,
  payload: Record<string, unknown>,
  nonce: string,
): Promise<Record<string, unknown>> {
  const envelope = await buildEnvelope(
    secret,
    { ...payload, contractVersion: CONTRACT_VERSION },
    Math.floor(fixedNow.getTime() / 1000),
    nonce,
  )
  const output = harness.doPost({ postData: { contents: JSON.stringify(envelope) } })
  expect(output.getMimeType()).toBe('application/json')
  return JSON.parse(output.getContent()) as Record<string, unknown>
}

function requiredSheet(harness: FakeGasHarness, name: string): FakeSheet {
  const sheet = harness.spreadsheet.getSheetByName(name)
  if (!sheet) throw new Error(`missing test sheet: ${name}`)
  return sheet
}
