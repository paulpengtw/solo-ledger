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
    setSourceObservationId(journal, 2, 'observation:known-setup')
    harness.setupSpreadsheet()

    const headers = journal
      .getRange(1, 1, 1, journal.getLastColumn())
      .getValues()[0]!
      .map(String)
    const observationColumn = headers.indexOf('source_observation_id')
    expect(observationColumn).toBeGreaterThanOrEqual(0)
    expect(String(journal.getRange(2, observationColumn + 1).getValues()[0]![0])).toBe('observation:known-setup')
    expect(journal.getRange(2, 13).getValues()[0]![0]).toBe('')
  })

  it('classifies a blank event identity as unidentified in a pinned lookup', async () => {
    harness.setupSpreadsheet()
    const journal = requiredSheet(harness, '日記帳')
    journal.getRange(2, 1, 1, journalHeaders.length).setValues([[
      '2026-07-27', '12:34', '測試', '餐飲', '現金', '1', 'TWD', '測試分類',
      '測試對象', 'legacy row', '', '', '', 'test-fixture', '2026-07-27T12:34:00+08:00',
    ]])
    setSourceObservationId(journal, 2, 'observation:legacy-event')

    const snapshot = await post(harness, {
      action: 'snapshot',
      scope: 'events',
    }, 'identity-lookup-snapshot')
    const revision = String(snapshot.snapshotRevision)
    const headers = journal.getRange(1, 1, 1, journal.getLastColumn()).getValues()[0]!.map(String)
    const observationColumn = headers.indexOf('source_observation_id')
    const observationId = String(journal.getRange(2, observationColumn + 1).getValues()[0]![0])

    const lookup = await post(harness, {
      action: 'lookup',
      scope: 'events',
      ids: [observationId],
      snapshotRevision: revision,
    }, 'identity-lookup-001')

    expect(lookup).toMatchObject({
      kind: 'ok',
      snapshotRevision: revision,
      missing: [],
      unidentified: [observationId],
    })
    expect(lookup.records).toEqual([
      expect.objectContaining({
        id: null,
        identity: { kind: 'unidentified', reason: 'blank-txn-id' },
        sourceObservationId: observationId,
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
    setSourceObservationId(journal, 2, 'observation:automatic-update-refusal')
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

  it('does not classify pwa, manual, or transfer rows as source observations', async () => {
    harness.setupSpreadsheet()
    const journal = requiredSheet(harness, '日記帳')
    journal.getRange(2, 1, 3, journalHeaders.length).setValues([
      ['2026-07-27', '12:34', '測試', '餐飲', '現金', '1', 'TWD', '測試分類', '測試對象', 'pwa', '', '', 'event:pwa', 'pwa', '2026-07-27T12:34:00+08:00'],
      ['2026-07-27', '12:35', '測試', '餐飲', '現金', '1', 'TWD', '測試分類', '測試對象', 'manual', '', '', 'event:manual', '手動', '2026-07-27T12:35:00+08:00'],
      ['2026-07-27', '12:36', '轉帳', '銀行', '現金', '1', 'TWD', '', '', 'transfer', '', '', 'event:transfer', '移轉', '2026-07-27T12:36:00+08:00'],
    ])

    const observations = await post(harness, { action: 'snapshot', scope: 'observations' }, 'identity-non-observation-snapshot')
    expect(observations.records).toEqual([])
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
    setSourceObservationId(journal, 2, 'observation:known-lookup')
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
      expect.objectContaining({ id: observationId, sourceObservationId: observationId }),
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
    harness.setupSpreadsheet()

    const journalHeadersAfterSetup = journal.getRange(1, 1, 1, journal.getLastColumn()).getValues()[0]!.map(String)
    const observationColumn = journalHeadersAfterSetup.indexOf('source_observation_id')
    expect(accounts.getRange(accountRow, stableIdColumn + 1).getValues()[0]![0]).toBe('')
    expect(journal.getRange(2, observationColumn + 1).getValues()[0]![0]).toBe('')

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
      identity: { kind: 'unidentified', reason: 'blank-source-observation-id' },
    })
    const before = journal.getRange(2, 1, 1, journal.getLastColumn()).getValues()[0]!
    const adopted = await post(harness, {
      action: 'adopt_identity',
      operationId: 'identity-observation-adoption-001',
      expectedSnapshotRevision: String(observationSnapshot.snapshotRevision),
      repairReference: observationRecord.repairReference,
      stableId: 'observation:legacy-001',
    }, 'identity-observation-adoption-001')
    expect(adopted).toMatchObject({ ok: true, scope: 'observations', stableId: 'observation:legacy-001' })
    const after = journal.getRange(2, 1, 1, journal.getLastColumn()).getValues()[0]!
    expect(after).toEqual(before.map((value, index) =>
      index === observationColumn ? 'observation:legacy-001' : value))
  })

  it('adopts a reviewed identity while leaving every original source cell unchanged', async () => {
    harness.setupSpreadsheet()
    const journal = requiredSheet(harness, '日記帳')
    journal.getRange(2, 1, 1, journalHeaders.length).setValues([[
      '2026-07-27', '12:34', '測試', '餐飲', '現金', '1', 'TWD', '測試分類',
      '測試對象', 'legacy row', '', '', '', 'test-fixture', '2026-07-27T12:34:00+08:00',
    ]])
    setSourceObservationId(journal, 2, 'observation:adopt-event')

    const snapshot = await post(harness, {
      action: 'snapshot',
      scope: 'events',
    }, 'identity-adopt-snapshot')
    const revision = String(snapshot.snapshotRevision)
    const headers = journal.getRange(1, 1, 1, journal.getLastColumn()).getValues()[0]!.map(String)
    const observationColumn = headers.indexOf('source_observation_id')
    const observationId = String(journal.getRange(2, observationColumn + 1).getValues()[0]![0])
    const lookup = await post(harness, {
      action: 'lookup',
      scope: 'events',
      ids: [observationId],
      snapshotRevision: revision,
    }, 'identity-adopt-lookup')
    const repairReference = (lookup.records as Array<Record<string, unknown>>)[0]!.repairReference
    const before = journal.getRange(2, 1, 1, journal.getLastColumn()).getValues()[0]!

    const adopted = await post(harness, {
      action: 'adopt_identity',
      operationId: 'identity-adoption-001',
      expectedSnapshotRevision: revision,
      repairReference,
      stableId: 'event:legacy-001',
    }, 'identity-adoption-001')
    expect(adopted).toMatchObject({
      ok: true,
      operationId: 'identity-adoption-001',
      stableId: 'event:legacy-001',
      sheetRow: 2,
    })
    const after = journal.getRange(2, 1, 1, journal.getLastColumn()).getValues()[0]!
    expect(after).toEqual(before.map((value, index) =>
      index === 12 ? 'event:legacy-001' : value))

    const events = await post(harness, {
      action: 'snapshot',
      scope: 'events',
    }, 'identity-adopt-events')
    expect(events.records).toEqual([
      expect.objectContaining({
        id: 'event:legacy-001',
        identity: { kind: 'identified', txnId: 'event:legacy-001' },
      }),
    ])
  })

  it('durably replays identical adoption and conflicts on changed operation content', async () => {
    harness.setupSpreadsheet()
    const journal = requiredSheet(harness, '日記帳')
    journal.getRange(2, 1, 1, journalHeaders.length).setValues([[
      '2026-07-27', '12:34', '測試', '餐飲', '現金', '1', 'TWD', '測試分類',
      '測試對象', 'legacy row', '', '', '', 'test-fixture', '2026-07-27T12:34:00+08:00',
    ]])
    setSourceObservationId(journal, 2, 'observation:replay-event')
    const snapshot = await post(harness, { action: 'snapshot', scope: 'events' }, 'identity-replay-snapshot')
    const revision = String(snapshot.snapshotRevision)
    const observationId = String(journal.getRange(2, journal.getLastColumn()).getValues()[0]![0])
    const lookup = await post(harness, {
      action: 'lookup', scope: 'events', ids: [observationId], snapshotRevision: revision,
    }, 'identity-replay-lookup')
    const reference = (lookup.records as Array<Record<string, unknown>>)[0]!.repairReference
    const request = {
      action: 'adopt_identity',
      operationId: 'identity-adoption-replay',
      expectedSnapshotRevision: revision,
      repairReference: reference,
      stableId: 'event:replay-001',
    }

    const first = await post(harness, request, 'identity-replay-first')
    const second = await post(harness, request, 'identity-replay-second')
    expect(second).toEqual({ ...first, already: true })

    const changed = await post(harness, { ...request, stableId: 'event:replay-002' }, 'identity-replay-changed')
    expect(changed).toMatchObject({
      ok: false,
      kind: 'conflict',
      operationId: 'identity-adoption-replay',
      reason: 'operation-content-changed',
    })
    expect(journal.getRange(2, 13).getValues()[0]![0]).toBe('event:replay-001')
  })

  it('refuses stale revisions and changed target content before writing identity metadata', async () => {
    harness.setupSpreadsheet()
    const journal = requiredSheet(harness, '日記帳')
    journal.getRange(2, 1, 1, journalHeaders.length).setValues([[
      '2026-07-27', '12:34', '測試', '餐飲', '現金', '1', 'TWD', '測試分類',
      '測試對象', 'legacy row', '', '', '', 'test-fixture', '2026-07-27T12:34:00+08:00',
    ]])
    setSourceObservationId(journal, 2, 'observation:conflict-event')
    const snapshot = await post(harness, { action: 'snapshot', scope: 'events' }, 'identity-conflict-snapshot')
    const revision = String(snapshot.snapshotRevision)
    const observationId = String(journal.getRange(2, journal.getLastColumn()).getValues()[0]![0])
    const lookup = await post(harness, {
      action: 'lookup', scope: 'events', ids: [observationId], snapshotRevision: revision,
    }, 'identity-conflict-lookup')
    const reference = (lookup.records as Array<Record<string, unknown>>)[0]!.repairReference as Record<string, unknown>

    journal.getRange(2, 10).setValues([['changed after review']])
    const stale = await post(harness, {
      action: 'adopt_identity',
      operationId: 'identity-adoption-stale',
      expectedSnapshotRevision: revision,
      repairReference: reference,
      stableId: 'event:stale-001',
    }, 'identity-adoption-stale')
    expect(stale).toMatchObject({ ok: false, kind: 'conflict', reason: 'revision-changed' })
    expect(journal.getRange(2, 13).getValues()[0]![0]).toBe('')

    const current = await post(harness, { action: 'snapshot', scope: 'events' }, 'identity-conflict-current')
    const currentRevision = String(current.snapshotRevision)
    const currentLookup = await post(harness, {
      action: 'lookup', scope: 'events', ids: [observationId], snapshotRevision: currentRevision,
    }, 'identity-conflict-current-lookup')
    const wrongReference = {
      ...(currentLookup.records as Array<Record<string, unknown>>)[0]!.repairReference as Record<string, unknown>,
      contentDigest: '0'.repeat(64),
    }
    const changed = await post(harness, {
      action: 'adopt_identity',
      operationId: 'identity-adoption-content',
      expectedSnapshotRevision: currentRevision,
      repairReference: wrongReference,
      stableId: 'event:content-001',
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
        '測試對象', 'legacy', '', '', 'event:existing', 'test-fixture', '2026-07-27T12:34:00+08:00',
      ],
      [
        '2026-07-27', '12:34', '測試', '餐飲', '現金', '1', 'TWD', '測試分類',
        '測試對象', 'legacy', '', '', '', 'test-fixture', '2026-07-27T12:34:00+08:00',
      ],
    ])
    setSourceObservationId(journal, 3, 'observation:ambiguous-event')
    const snapshot = await post(harness, { action: 'snapshot', scope: 'events' }, 'identity-duplicate-snapshot')
    const revision = String(snapshot.snapshotRevision)
    const observationId = String(journal.getRange(3, journal.getLastColumn()).getValues()[0]![0])
    const lookup = await post(harness, {
      action: 'lookup', scope: 'events', ids: [observationId], snapshotRevision: revision,
    }, 'identity-duplicate-lookup')
    const reference = (lookup.records as Array<Record<string, unknown>>)[0]!.repairReference as Record<string, unknown>
    const duplicate = await post(harness, {
      action: 'adopt_identity',
      operationId: 'identity-adoption-duplicate',
      expectedSnapshotRevision: revision,
      repairReference: reference,
      stableId: 'event:existing',
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
      stableId: 'event:ambiguous',
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

function setSourceObservationId(journal: FakeSheet, row: number, id: string): void {
  const headers = journal.getRange(1, 1, 1, journal.getLastColumn()).getValues()[0]!.map(String)
  const column = headers.indexOf('source_observation_id')
  if (column < 0) throw new Error('missing source_observation_id header')
  journal.getRange(row, column + 1).setValues([[id]])
}
