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
      'observation:known-setup', 'test-fixture:row-1', 'source-content-1',
    ]])
    harness.setupSpreadsheet()

    expect(observations.getRange(2, 1, 1, observationHeaders.length).getValues()[0]).toEqual([
      'observation:known-setup', 'test-fixture:row-1', 'source-content-1',
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
      ['observation:one', 'bank:row-1', 'digest-one'],
      ['observation:two', 'bank:row-2', 'digest-two'],
    ])

    const observations = await post(harness, { action: 'snapshot', scope: 'observations' }, 'identity-non-observation-snapshot')
    expect(observations.records).toHaveLength(2)
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
      'observation:known-lookup', 'import:file-1:row-2', 'source-content-2',
    ]])
    harness.setupSpreadsheet()

    const observations = await post(harness, { action: 'snapshot', scope: 'observations' }, 'identity-observation-snapshot')
    const observationId = String((observations.records as Array<Record<string, unknown>>)[0]!.id)
    const accountSnapshot = await post(harness, { action: 'snapshot', scope: 'accounts' }, 'identity-account-snapshot')
    const revision = String(accountSnapshot.snapshotRevision)
    const accountsLookup = await post(harness, {
      action: 'lookup', scope: 'accounts', ids: [accountId], snapshotRevision: revision,
    }, 'identity-account-lookup')
    const observationsLookup = await post(harness, {
      action: 'lookup', scope: 'observations', ids: [observationId], snapshotRevision: revision,
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
    const lookup = await post(harness, {
      action: 'lookup', scope: 'accounts', ids: ['account:現金'], snapshotRevision: revision,
    }, 'identity-account-adopt-lookup')
    expect(lookup).toMatchObject({ kind: 'ok', missing: [], unidentified: ['account:現金'] })
    const reference = (lookup.records as Array<Record<string, unknown>>)[0]!.repairReference

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
      '', 'legacy-source:row-1', 'legacy-content-1',
    ]])
    harness.setupSpreadsheet()

    expect(accounts.getRange(accountRow, stableIdColumn + 1).getValues()[0]![0]).toBe('')
    expect(observationSheet.getRange(2, 1).getValues()[0]![0]).toBe('')

    const accountSnapshot = await post(harness, { action: 'snapshot', scope: 'accounts' }, 'identity-legacy-account-snapshot')
    const accountRevision = String(accountSnapshot.snapshotRevision)
    const accountLookup = await post(harness, {
      action: 'lookup', scope: 'accounts', ids: ['account:現金'], snapshotRevision: accountRevision,
    }, 'identity-legacy-account-lookup')
    expect(accountLookup).toMatchObject({ kind: 'ok', missing: [], unidentified: ['account:現金'] })
    expect(accountLookup.records).toEqual([
      expect.objectContaining({ identity: { kind: 'unidentified', reason: 'missing-stable-id' } }),
    ])

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
