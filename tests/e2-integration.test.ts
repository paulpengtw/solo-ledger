import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildEnvelope } from '../functions/lib/envelope'
import { CONTRACT_VERSION } from '../src/generated/version'
import { loadGasFunctionsWithFakeGas, type FakeGasHarness, type FakeTextOutput } from './helpers/gas'

const secret = 'test-secret'
const fixedNow = new Date('2026-07-27T00:00:00.000Z')
const journalHeaders = [
  '日期', '時間', '類型', '借方帳戶', '貸方帳戶', '金額', '幣別', '分類',
  '交易對象', '說明', '結清狀態', '沖銷txn_id', 'txn_id', '來源', '建立時間',
]

describe('E2 reviewed Personal operations', () => {
  let harness: FakeGasHarness

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(fixedNow)
    harness = loadGasFunctionsWithFakeGas()
    harness.setupSpreadsheet()
  })

  it('serializes observation claims and discovers a durable outcome after cache expiry', async () => {
    const first = await post(harness, {
      action: 'command', operationId: 'claim-a', expectedRevisions: [],
      contentDigest: 'digest-plan-0001', content: { kind: 'claims',
        claims: ['observation:one'],
      },
    }, 'claim-a-transport')
    expect(first).toMatchObject({ kind: 'committed', operationId: 'claim-a' })

    const second = await post(harness, {
      action: 'command', operationId: 'claim-b', expectedRevisions: [],
      contentDigest: 'digest-plan-0002', content: { kind: 'claims', claims: ['observation:one'] },
    }, 'claim-b-transport')
    expect(second).toMatchObject({ kind: 'conflict', reason: 'observation-already-claimed' })

    harness.advanceCacheTime(601)
    expect(await post(harness, {
      action: 'outcome', operationId: 'claim-a',
    }, 'claim-outcome-transport')).toMatchObject({ kind: 'committed', operationId: 'claim-a' })

    const changed = await post(harness, {
      action: 'command', operationId: 'claim-a', expectedRevisions: [],
      contentDigest: 'digest-plan-changed', content: { kind: 'claims', claims: ['observation:one-changed'] },
    }, 'claim-a-changed-transport')
    expect(changed).toMatchObject({ kind: 'conflict', reason: 'operation-id-reused-with-different-content' })
  })

  it('forwards event-group claims and reserves them before journal effects', async () => {
    const journal = harness.spreadsheet.getSheetByName('日記帳')!
    journal.failNextSetValues('journal effect failed')

    const attempted = await post(harness, {
      action: 'create_event_group', operationId: 'group-claim-reservation',
      claims: ['observation:event-group'], group: {
        groupId: 'group-claim-reservation', legs: [
          {
            txnId: '00000000-0000-4000-8000-000000000930', date: '2026-07-27',
            type: '轉帳', debitAccount: '銀行', creditAccount: '現金', amount: '10', currency: 'TWD',
          },
        ],
      },
    }, 'group-claim-reservation-transport')
    expect(attempted).toEqual({
      kind: 'unknown', operationId: 'group-claim-reservation', reason: 'write-outcome-unknown',
    })
    expect(journalRows(harness)).toHaveLength(0)

    const claims = await post(harness, { action: 'snapshot', scope: 'claims' }, 'group-claim-reservation-snapshot')
    expect(claims.records).toEqual([
      expect.objectContaining({
        claimId: 'observation:event-group', operationId: 'group-claim-reservation', status: 'claimed',
      }),
    ])

    const competing = await post(harness, {
      action: 'create_event_group', operationId: 'group-claim-competing',
      claims: ['observation:event-group'], group: {
        groupId: 'group-claim-competing', legs: [
          {
            txnId: '00000000-0000-4000-8000-000000000931', date: '2026-07-27',
            type: '轉帳', debitAccount: '銀行', creditAccount: '現金', amount: '10', currency: 'TWD',
          },
        ],
      },
    }, 'group-claim-competing-transport')
    expect(competing).toMatchObject({ kind: 'conflict', reason: 'observation-already-claimed' })
  })

  it('forwards import claims into the durable competing-claim gate', async () => {
    const accepted = await post(harness, {
      action: 'accept_import', operationId: 'manifest-claim-owner',
      claims: ['observation:manifest'], manifest: {
        manifestId: 'manifest-claim-owner', sourceEvidence: ['evidence-claim-owner'],
      }, steps: [
        { stepId: 'create-one', disposition: 'create', state: 'completed', destinationId: 'event-claim-owner', destinationRevision: 'rev-1' },
      ],
    }, 'manifest-claim-owner-transport')
    expect(accepted).toMatchObject({ kind: 'committed', operationId: 'manifest-claim-owner' })
    expect(await post(harness, { action: 'snapshot', scope: 'claims' }, 'manifest-claim-owner-snapshot')).toMatchObject({
      records: [expect.objectContaining({ claimId: 'observation:manifest', operationId: 'manifest-claim-owner' })],
    })

    const competing = await post(harness, {
      action: 'accept_import', operationId: 'manifest-claim-competing',
      claims: ['observation:manifest'], manifest: {
        manifestId: 'manifest-claim-competing', sourceEvidence: ['evidence-claim-competing'],
      }, steps: [
        { stepId: 'create-one', disposition: 'create', state: 'completed', destinationId: 'event-claim-competing', destinationRevision: 'rev-2' },
      ],
    }, 'manifest-claim-competing-transport')
    expect(competing).toMatchObject({ kind: 'conflict', reason: 'observation-already-claimed' })
  })

  it('does not reserve claims for rejected event groups or import plans', async () => {
    const rejectedGroup = await post(harness, {
      action: 'create_event_group', operationId: 'group-claim-rejected',
      claims: ['observation:rejected-group'], group: {
        groupId: 'group-claim-rejected', legs: [],
      },
    }, 'group-claim-rejected-transport')
    expect(rejectedGroup).toMatchObject({ kind: 'rejected', reason: 'group-legs-required' })

    const rejectedImport = await post(harness, {
      action: 'accept_import', operationId: 'manifest-claim-rejected',
      claims: ['observation:rejected-import'], manifest: {
        manifestId: 'manifest-claim-rejected', sourceEvidence: ['evidence-claim-rejected'],
      }, steps: [
        { stepId: 'invalid-link', disposition: 'link', state: 'completed' },
      ],
    }, 'manifest-claim-rejected-transport')
    expect(rejectedImport).toMatchObject({ kind: 'rejected', reason: 'plan-incomplete' })
    expect((await post(harness, { action: 'snapshot', scope: 'claims' }, 'rejected-claims-snapshot')).records).toEqual([])
  })

  it('does not strand a claim when a leg conflicts before its first effect', async () => {
    const first = await post(harness, {
      action: 'create_event_group', operationId: 'group-existing-leg', group: {
        groupId: 'group-existing-leg', legs: [{
          txnId: '00000000-0000-4000-8000-000000000932', date: '2026-07-27',
          type: '轉帳', debitAccount: '銀行', creditAccount: '現金', amount: '10', currency: 'TWD',
        }],
      },
    }, 'group-existing-leg-transport')
    expect(first).toMatchObject({ kind: 'committed' })

    const conflicting = await post(harness, {
      action: 'create_event_group', operationId: 'group-existing-leg-conflict',
      claims: ['observation:conflicting-leg'], group: {
        groupId: 'group-existing-leg-conflict', legs: [{
          txnId: '00000000-0000-4000-8000-000000000932', date: '2026-07-27',
          type: '轉帳', debitAccount: '銀行', creditAccount: '現金', amount: '10', currency: 'TWD',
        }],
      },
    }, 'group-existing-leg-conflict-transport')
    expect(conflicting).toMatchObject({ kind: 'conflict', reason: 'txn-id-already-exists' })
    expect((await post(harness, { action: 'snapshot', scope: 'claims' }, 'conflicting-leg-claims-snapshot')).records)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ claimId: 'observation:conflicting-leg' })]))
  })

  it('releases claims when a direct metadata command rejects before writing', async () => {
    const rejected = await post(harness, {
      action: 'record_evidence', operationId: 'evidence-invalid-claim-release',
      claims: ['observation:evidence-release'],
      evidence: { evidenceId: 'evidence-invalid', sourceReference: '' },
    }, 'evidence-invalid-claim-release-transport')
    expect(rejected).toMatchObject({ kind: 'rejected', reason: 'invalid-source-evidence' })

    const accepted = await post(harness, {
      action: 'command', operationId: 'claim-after-evidence-rejection', expectedRevisions: [],
      contentDigest: 'claim-after-evidence-rejection',
      content: { kind: 'claims', claims: ['observation:evidence-release'] },
    }, 'claim-after-evidence-rejection-transport')
    expect(accepted).toMatchObject({ kind: 'committed', operationId: 'claim-after-evidence-rejection' })
    expect((await post(harness, { action: 'snapshot', scope: 'claims' }, 'evidence-release-claim-snapshot')).records)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ claimId: 'observation:evidence-release', operationId: 'claim-after-evidence-rejection', status: 'claimed' }),
      ]))
  })

  it('discovers durable outcomes while financial writes are closed and records actor provenance', async () => {
    const committed = await post(harness, {
      action: 'command', operationId: 'maintenance-outcome', actor: 'verified-actor', expectedRevisions: [],
      contentDigest: 'actor-transport', content: { kind: 'claims', claims: ['observation:maintenance'] },
    }, 'maintenance-outcome-transport')
    expect(committed).toMatchObject({ kind: 'committed', operationId: 'maintenance-outcome' })
    const operations = await post(harness, { action: 'snapshot', scope: 'operations' }, 'maintenance-operation-snapshot')
    const operation = (operations.records as Array<Record<string, unknown>>).find(record => record.operationId === 'maintenance-outcome')
    expect(operation).toEqual(expect.objectContaining({ detail: expect.objectContaining({ actor: 'verified-actor' }) }))
    const actorRecords = await post(harness, { action: 'snapshot', scope: 'records' }, 'maintenance-actor-record-snapshot')
    expect(actorRecords.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'actor-provenance', data: expect.objectContaining({ actor: 'verified-actor' }) }),
    ]))
    harness.setScriptProperty('INTEGRATION_OPEN', 'false')
    expect(await post(harness, { action: 'outcome', operationId: 'maintenance-outcome' }, 'maintenance-outcome-lookup'))
      .toMatchObject({ kind: 'committed', operationId: 'maintenance-outcome' })
  })

  it('advertises E2 capabilities only after the durable metadata schema is enabled', async () => {
    const before = await post(harness, { action: 'integrationState' }, 'e2-capabilities-before')
    expect(before.capabilities).toEqual(['complete-revisioned-reads', 'stable-identity'])
    await post(harness, { action: 'enable_e2' }, 'e2-capabilities-enable-transport')
    const after = await post(harness, { action: 'integrationState' }, 'e2-capabilities-after')
    expect(after.capabilities).toEqual([
      'complete-revisioned-reads', 'stable-identity', 'content-conflict-detection',
      'native-currency-groups', 'pending-confirmation-states', 'durable-operation-outcomes',
      'link-metadata', 'reconciliation-metadata',
    ])
  })

  it('reads 450 E2 metadata records across pages and proves the explicit end', async () => {
    await post(harness, { action: 'enable_e2' }, 'e2-read-over-cap-enable')
    const records = harness.spreadsheet.getSheetByName('整合記錄')!
    records.getRange(2, 1, 450, 5).setValues(Array.from({ length: 450 }, (_, index) => [
      'synthetic-read',
      `record-${String(index).padStart(3, '0')}`,
      `revision-${index}`,
      JSON.stringify({ index }),
      `2026-07-27T00:${String(index % 60).padStart(2, '0')}:00+08:00`,
    ]))

    const pages: Array<Record<string, unknown>> = []
    let cursor: string | undefined
    let snapshotRevision: string | undefined
    for (;;) {
      const page = await post(harness, {
        action: 'snapshot',
        scope: 'records',
        ...(cursor === undefined ? {} : { cursor }),
        ...(snapshotRevision === undefined ? {} : { snapshotRevision }),
      }, `e2-read-over-cap-${pages.length}`)
      pages.push(page)
      if (snapshotRevision === undefined) snapshotRevision = String(page.snapshotRevision)
      const continuation = page.continuation as { kind: string; cursor?: string }
      if (continuation.kind === 'end') break
      expect(continuation.kind).toBe('cursor')
      cursor = continuation.cursor
    }

    expect(pages.map(page => (page.records as unknown[]).length)).toEqual([200, 200, 50])
    expect(pages.at(-1)).toMatchObject({ continuation: { kind: 'end' } })
    expect(new Set(pages.flatMap(page => (page.records as Array<Record<string, unknown>>).map(record => record.id))).size)
      .toBe(450)
  })

  it('refuses a continuation when E2 metadata changes between pages', async () => {
    await post(harness, { action: 'enable_e2' }, 'e2-read-revision-enable')
    const records = harness.spreadsheet.getSheetByName('整合記錄')!
    records.getRange(2, 1, 210, 5).setValues(Array.from({ length: 210 }, (_, index) => [
      'synthetic-revision',
      `record-${String(index).padStart(3, '0')}`,
      `revision-${index}`,
      JSON.stringify({ index }),
      '2026-07-27T00:00:00+08:00',
    ]))

    const first = await post(harness, {
      action: 'snapshot', scope: 'records',
    }, 'e2-read-revision-first')
    expect(first.continuation).toEqual({ kind: 'cursor', cursor: '200' })
    const snapshotRevision = String(first.snapshotRevision)
    records.getRange(211, 4).setValues([[JSON.stringify({ index: 209, changed: true })]])

    expect(await post(harness, {
      action: 'snapshot', scope: 'records', cursor: '200', snapshotRevision,
    }, 'e2-read-revision-second')).toEqual({
      kind: 'revision-changed',
      book: 'personal',
      expected: snapshotRevision,
      actual: expect.any(String),
    })
  })

  it('records native-currency groups and excludes incomplete groups from balances', async () => {
    const complete = await post(harness, {
      action: 'create_event_group', operationId: 'group-complete', actor: 'group-actor', group: {
        groupId: 'group-complete', legs: [
          { txnId: '00000000-0000-4000-8000-000000000901', date: '2026-07-27', type: '轉帳', debitAccount: '銀行', creditAccount: '現金', amount: '3200', currency: 'TWD' },
          { txnId: '00000000-0000-4000-8000-000000000902', feeId: 'fee-1', kind: 'fee', date: '2026-07-27', type: '支出', category: '餐飲', debitAccount: '餐飲', creditAccount: '現金', amount: '10', currency: 'TWD', source: 'integration' },
          { txnId: '00000000-0000-4000-8000-000000000903', date: '2026-07-27', type: '轉帳', debitAccount: '現金', creditAccount: '銀行', amount: '100', currency: 'USD' },
        ],
        conversion: { reference: 'fx:2026-07-27:twd-usd', clearingReference: 'clearing:group-complete' },
        fees: [{ feeId: 'fee-1', amount: '10', currency: 'TWD' }],
        currencyTotals: [
          { currency: 'TWD', debit: '3210', credit: '3210' },
          { currency: 'USD', debit: '100', credit: '100' },
        ],
      },
    }, 'group-complete-transport')
    expect(complete).toMatchObject({ kind: 'committed' })
    const completeJournalRows = journalRows(harness)
    expect(completeJournalRows.find(row => row[12] === '00000000-0000-4000-8000-000000000902')?.[13]).toBe('import')
    const groups = await post(harness, { action: 'snapshot', scope: 'groups' }, 'group-snapshot')
    expect(groups.records).toEqual([expect.objectContaining({
      id: 'group-complete', status: 'complete', completion: { kind: 'complete', marker: expect.any(String) },
      conversion: { reference: 'fx:2026-07-27:twd-usd', clearingReference: 'clearing:group-complete' },
      fees: [{ feeId: 'fee-1', amount: '10', currency: 'TWD' }],
      actor: 'group-actor',
    })])

    harness.spreadsheet.getSheetByName('日記帳')!.failNextSetValues('simulated group leg failure')
    const groupSheet = harness.spreadsheet.getSheetByName('事件群組')!
    const groupRowsBeforeFailure = groupSheet.getLastRow()
    const failed = await post(harness, {
      action: 'create_event_group', operationId: 'group-incomplete', group: {
        groupId: 'group-incomplete', legs: [
          { txnId: '00000000-0000-4000-8000-000000000904', date: '2026-07-27', type: '轉帳', debitAccount: '銀行', creditAccount: '現金', amount: '10', currency: 'TWD' },
          { txnId: '00000000-0000-4000-8000-000000000905', date: '2026-07-27', type: '轉帳', debitAccount: '現金', creditAccount: '銀行', amount: '5', currency: 'TWD' },
        ],
      },
    }, 'group-incomplete-transport')
    expect(failed).toEqual({ kind: 'unknown', operationId: 'group-incomplete', reason: 'write-outcome-unknown' })
    expect(groupSheet.getLastRow()).toBeGreaterThan(groupRowsBeforeFailure)
    const incomplete = await post(harness, { action: 'snapshot', scope: 'groups' }, 'group-incomplete-snapshot')
    expect(incomplete.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'group-incomplete', status: 'incomplete', completion: { kind: 'incomplete', marker: null } }),
    ]))

    const resumed = await post(harness, {
      action: 'create_event_group', operationId: 'group-incomplete-retry', group: {
        groupId: 'group-incomplete', legs: [
          { txnId: '00000000-0000-4000-8000-000000000904', date: '2026-07-27', type: '轉帳', debitAccount: '銀行', creditAccount: '現金', amount: '10', currency: 'TWD' },
          { txnId: '00000000-0000-4000-8000-000000000905', date: '2026-07-27', type: '轉帳', debitAccount: '現金', creditAccount: '銀行', amount: '5', currency: 'TWD' },
        ],
      },
    }, 'group-incomplete-retry-transport')
    expect(resumed).toMatchObject({ kind: 'committed' })
    expect(await post(harness, { action: 'snapshot', scope: 'groups' }, 'group-retry-snapshot')).toEqual(expect.objectContaining({
      records: expect.arrayContaining([
        expect.objectContaining({ id: 'group-incomplete', status: 'complete', completion: { kind: 'complete', marker: expect.any(String) } }),
      ]),
    }))

    const changed = await post(harness, {
      action: 'create_event_group', operationId: 'group-changed-content', group: {
        groupId: 'group-complete', legs: [
          { txnId: '00000000-0000-4000-8000-000000000901', date: '2026-07-27', type: '轉帳', debitAccount: '銀行', creditAccount: '現金', amount: '3201', currency: 'TWD' },
        ],
      },
    }, 'group-changed-content-transport')
    expect(changed).toMatchObject({ kind: 'conflict', reason: 'group-id-reused-with-different-content' })

    const duplicateLegs = await post(harness, {
      action: 'create_event_group', operationId: 'group-duplicate-legs', group: {
        groupId: 'group-duplicate-legs', legs: [
          { txnId: '00000000-0000-4000-8000-000000000906', date: '2026-07-27', type: '轉帳', debitAccount: '銀行', creditAccount: '現金', amount: '10', currency: 'TWD' },
          { txnId: '00000000-0000-4000-8000-000000000906', date: '2026-07-27', type: '轉帳', debitAccount: '現金', creditAccount: '銀行', amount: '10', currency: 'TWD' },
        ],
      },
    }, 'group-duplicate-legs-transport')
    expect(duplicateLegs).toMatchObject({ kind: 'rejected', reason: 'group-duplicate-leg-id' })

    const invalidPosting = await post(harness, {
      action: 'create_event_group', operationId: 'group-invalid-posting', group: {
        groupId: 'group-invalid-posting', legs: [
          { txnId: 'not-a-uuid', date: '2026-07-27', type: '費用', debitAccount: '餐飲', creditAccount: '現金', amount: '10', currency: 'TWD', category: '尚未分類' },
        ],
      },
    }, 'group-invalid-posting-transport')
    expect(invalidPosting).toMatchObject({ kind: 'rejected', reason: 'group-posting-invalid' })

    const imbalanced = await post(harness, {
      action: 'create_event_group', operationId: 'group-imbalanced', group: {
        groupId: 'group-imbalanced', currencyTotals: [{ currency: 'TWD', debit: '3210', credit: '3200' }], legs: [
          { txnId: '00000000-0000-4000-8000-000000000906', date: '2026-07-27', type: '轉帳', debitAccount: '銀行', creditAccount: '現金', amount: '10', currency: 'TWD' },
        ],
      },
    }, 'group-imbalanced-transport')
    expect(imbalanced).toMatchObject({ kind: 'rejected', reason: 'group-not-balanced-within-currency' })
  })

  it('keeps an interrupted group leg out of balances and resumes the same operation', async () => {
    await post(harness, { action: 'enable_e2' }, 'group-detail-retry-enable')
    const detailSheet = harness.spreadsheet.getSheetByName('事件群組明細')!
    detailSheet.failNextSetValues('simulated group detail failure')
    const group = {
      groupId: 'group-detail-retry',
      legs: [{
        txnId: '00000000-0000-4000-8000-000000000921',
        date: '2026-07-27',
        type: '轉帳',
        debitAccount: '銀行',
        creditAccount: '現金',
        amount: '10',
        currency: 'TWD',
      }],
    }

    const first = await post(harness, {
      action: 'create_event_group', operationId: 'group-detail-retry-op', group,
    }, 'group-detail-retry-first-transport')
    expect(first).toEqual({ kind: 'unknown', operationId: 'group-detail-retry-op', reason: 'write-outcome-unknown' })

    const beforeRetry = await post(harness, { action: 'snapshot', scope: 'accounts' }, 'group-detail-retry-before-snapshot')
    expect(beforeRetry.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '現金', balances: [] }),
      expect.objectContaining({ name: '銀行', balances: [] }),
    ]))

    const retry = await post(harness, {
      action: 'create_event_group', operationId: 'group-detail-retry-op', group,
    }, 'group-detail-retry-second-transport')
    expect(retry).toMatchObject({ kind: 'committed', operationId: 'group-detail-retry-op' })
    expect((await post(harness, { action: 'snapshot', scope: 'groups' }, 'group-detail-retry-group-snapshot')).records)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'group-detail-retry', status: 'complete' }),
      ]))
  })

  it('reconciles missing manifest receipt steps when the response is lost', async () => {
    await post(harness, { action: 'enable_e2' }, 'manifest-receipt-retry-enable')
    const stepSheet = harness.spreadsheet.getSheetByName('匯入步驟')!
    stepSheet.failNextSetValues('simulated receipt step failure')
    const payload = {
      action: 'accept_import', operationId: 'manifest-receipt-retry', claims: ['observation:manifest-retry'],
      manifest: { manifestId: 'manifest-receipt-retry', sourceEvidence: ['evidence-manifest-retry'] },
      steps: [
        { stepId: 'first', disposition: 'create', state: 'completed', destinationId: 'event-receipt-first', destinationRevision: 'rev-first' },
        { stepId: 'second', disposition: 'skip', state: 'skipped', reason: 'already represented' },
      ],
    }
    const first = await post(harness, payload, 'manifest-receipt-retry-first-transport')
    expect(first).toEqual({ kind: 'unknown', operationId: 'manifest-receipt-retry', reason: 'write-outcome-unknown' })

    const retry = await post(harness, payload, 'manifest-receipt-retry-second-transport')
    expect(retry).toMatchObject({ kind: 'committed', operationId: 'manifest-receipt-retry' })
    const steps = (await post(harness, { action: 'snapshot', scope: 'steps' }, 'manifest-receipt-retry-steps')).records as Array<{ manifestId: string; stepId: string }>
    expect(steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ manifestId: 'manifest-receipt-retry', stepId: 'first', state: 'completed' }),
      expect.objectContaining({ manifestId: 'manifest-receipt-retry', stepId: 'second', state: 'skipped' }),
    ]))
    expect(steps.filter((step: { manifestId: string; stepId: string }) => step.manifestId === 'manifest-receipt-retry' && step.stepId === 'first')).toHaveLength(1)
    expect(steps.filter((step: { manifestId: string; stepId: string }) => step.manifestId === 'manifest-receipt-retry' && step.stepId === 'second')).toHaveLength(1)
  })

  it('validates Confirmation against the resulting state before writing', async () => {
    const journal = harness.spreadsheet.getSheetByName('日記帳')!
    journal.getRange(2, 1, 1, journalHeaders.length).setValues([[
      '2026-07-27', '12:00', '支出', '餐飲', '現金', '10', 'TWD', '尚未分類',
      '', 'pending', '', '', '00000000-0000-4000-8000-000000000904', 'import', '2026-07-27T12:00:00+08:00',
    ]])
    const before = journal.getRange(2, 1, 1, journalHeaders.length).getValues()[0]
    const refused = await post(harness, {
      action: 'confirm_event', operationId: 'confirm-refused', txnId: '00000000-0000-4000-8000-000000000904', confirmed: true,
    }, 'confirm-refused-transport')
    expect(refused).toMatchObject({ kind: 'rejected', reason: 'confirmation-requires-category' })
    expect(journal.getRange(2, 1, 1, journalHeaders.length).getValues()[0]).toEqual(before)

    const pending = await post(harness, {
      action: 'confirm_event', operationId: 'confirm-category-only', txnId: '00000000-0000-4000-8000-000000000904', category: '餐飲', confirmed: false,
    }, 'confirm-category-only-transport')
    expect(pending).toMatchObject({ kind: 'committed' })
    expect(journal.getRange(2, 1, 1, journalHeaders.length).getValues()[0]).toEqual(before)
    const pendingSnapshot = await post(harness, { action: 'snapshot', scope: 'events' }, 'confirm-pending-snapshot')
    expect(pendingSnapshot.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: '00000000-0000-4000-8000-000000000904',
        category: '餐飲', reviewState: 'pending', review_state: 'pending',
        review: expect.objectContaining({ state: 'pending', category: '餐飲', confirmedAt: null }),
      }),
    ]))
    const confirmed = await post(harness, {
      action: 'confirm_event', operationId: 'confirm-ok', txnId: '00000000-0000-4000-8000-000000000904', confirmed: true,
    }, 'confirm-ok-transport')
    expect(confirmed).toMatchObject({ kind: 'committed' })
    expect(journal.getRange(2, 1, 1, journalHeaders.length).getValues()[0]).toEqual(before)
    const confirmedSnapshot = await post(harness, { action: 'snapshot', scope: 'events' }, 'confirm-confirmed-snapshot')
    expect(confirmedSnapshot.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: '00000000-0000-4000-8000-000000000904',
        category: '餐飲', reviewState: 'confirmed', review_state: 'confirmed',
        review: expect.objectContaining({ state: 'confirmed', category: '餐飲', confirmedAt: expect.any(String) }),
      }),
    ]))

    const clearedWithoutPending = await post(harness, {
      action: 'confirm_event', operationId: 'confirm-clear-without-pending',
      txnId: '00000000-0000-4000-8000-000000000904', category: '', confirmed: false,
    }, 'confirm-clear-without-pending-transport')
    expect(clearedWithoutPending).toMatchObject({
      kind: 'rejected', reason: 'pending-transition-required',
    })
    const stillConfirmed = await post(harness, { action: 'snapshot', scope: 'events' }, 'confirm-still-confirmed-snapshot')
    expect(stillConfirmed.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: '00000000-0000-4000-8000-000000000904',
        category: '餐飲', reviewState: 'confirmed', review_state: 'confirmed',
      }),
    ]))

    const clearedWithPending = await post(harness, {
      action: 'confirm_event', operationId: 'confirm-clear-with-pending',
      txnId: '00000000-0000-4000-8000-000000000904', category: '', confirmed: false,
      pendingTransition: true,
    }, 'confirm-clear-with-pending-transport')
    expect(clearedWithPending).toMatchObject({ kind: 'committed' })
    const pendingAfterClear = await post(harness, { action: 'snapshot', scope: 'events' }, 'confirm-pending-after-clear-snapshot')
    expect(pendingAfterClear.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: '00000000-0000-4000-8000-000000000904',
        category: '尚未分類', reviewState: 'pending', review_state: 'pending',
        review: expect.objectContaining({ state: 'pending', category: '' }),
      }),
    ]))
  })

  it('persists complete, pending and conflicting import steps across reads', async () => {
    const accepted = await post(harness, {
      action: 'accept_import', operationId: 'manifest-op', actor: 'verified-auth-user', manifest: {
        manifestId: 'manifest-1', sourceEvidence: ['evidence-1'],
      }, steps: [
        { stepId: 'one', disposition: 'create', state: 'completed', destinationId: 'event-1', destinationRevision: 'rev-1' },
        { stepId: 'two', disposition: 'create', state: 'pending' },
        { stepId: 'three', disposition: 'link', state: 'conflicting', destinationId: 'event-3', destinationRevision: 'rev-3' },
      ],
    }, 'manifest-op-transport')
    expect(accepted).toMatchObject({ kind: 'committed' })
    const manifests = await post(harness, { action: 'snapshot', scope: 'manifests' }, 'manifest-snapshot')
    const steps = await post(harness, { action: 'snapshot', scope: 'steps' }, 'step-snapshot')
    expect(manifests.records).toEqual([expect.objectContaining({ manifestId: 'manifest-1', status: 'accepted', actor: 'verified-auth-user' })])
    expect(steps.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ stepId: 'one', state: 'completed', destination: { id: 'event-1', revision: 'rev-1' } }),
      expect.objectContaining({ stepId: 'two', state: 'pending' }),
      expect.objectContaining({ stepId: 'three', state: 'conflicting' }),
    ]))

    const staleStepRevision = await post(harness, {
      action: 'resume_import', operationId: 'manifest-stale-step-revision', manifestId: 'manifest-1', steps: [
        {
          stepId: 'two', state: 'completed', destinationId: 'event-2', destinationRevision: 'rev-2',
          expectedRevisions: [{ id: 'event-2', revision: 'revision-before-edit' }],
        },
      ],
    }, 'manifest-stale-step-revision-transport')
    expect(staleStepRevision).toMatchObject({ kind: 'conflict', reason: 'stale-expected-revision' })

    const resumed = await post(harness, {
      action: 'resume_import', operationId: 'manifest-omitted-pending-step', manifestId: 'manifest-1', steps: [
        { stepId: 'one', disposition: 'create', state: 'completed', destinationId: 'event-1', destinationRevision: 'rev-1' },
      ],
    }, 'manifest-omitted-pending-step-transport')
    expect(resumed).toMatchObject({ kind: 'committed' })
    expect((await post(harness, { action: 'snapshot', scope: 'manifests' }, 'manifest-omitted-pending-snapshot')).records)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ manifestId: 'manifest-1', status: 'conflicting' }),
      ]))
  })

  it('preflights the whole import plan before writing any manifest or step', async () => {
    const rejected = await post(harness, {
      action: 'accept_import', operationId: 'manifest-invalid', manifest: {
        manifestId: 'manifest-invalid', sourceEvidence: ['evidence-1'],
      }, steps: [
        { stepId: 'valid-first', disposition: 'create', state: 'completed', destinationId: 'event-1', destinationRevision: 'rev-1' },
        { stepId: 'invalid-link', disposition: 'link', state: 'completed' },
      ],
    }, 'manifest-invalid-transport')
    expect(rejected).toMatchObject({ kind: 'rejected', reason: 'plan-incomplete' })
    expect((await post(harness, { action: 'snapshot', scope: 'manifests' }, 'manifest-invalid-snapshot')).records).toEqual([])
    expect((await post(harness, { action: 'snapshot', scope: 'steps' }, 'step-invalid-snapshot')).records).toEqual([])
  })

  it('rejects an unsupported command kind without writing generic records', async () => {
    const rejected = await post(harness, {
      action: 'command', operationId: 'unsupported-command', expectedRevisions: [],
      contentDigest: 'transport-digest', content: {
        kind: 'record',
        writes: [{ scope: 'records', id: 'must-not-write', data: { value: 1 } }],
      },
    }, 'unsupported-command-transport')
    expect(rejected).toMatchObject({ kind: 'rejected', reason: 'unsupported-command-kind' })
    expect((await post(harness, { action: 'snapshot', scope: 'records' }, 'unsupported-command-snapshot')).records).toEqual([])
  })

  it('persists import receipts and exposes the latest progress by results scope', async () => {
    const receipt = {
      operationId: 'receipt-operation', planId: 'plan-1', contractVersion: CONTRACT_VERSION,
      actor: 'cheng', acceptedAt: '2026-07-27T08:00:00.000Z', contentDigest: 'plan-digest',
      steps: [{ stepId: 'step-1', kind: 'claim-observation', book: 'personal', expectedRevisions: [], dependsOn: [], state: { kind: 'pending' } }],
      state: { kind: 'accepted' },
    }
    const accepted = await post(harness, {
      action: 'command', operationId: 'receipt-operation', expectedRevisions: [],
      contentDigest: 'receipt-content', content: {
        kind: 'import-receipt',
        writes: [{ scope: 'results', id: 'receipt-operation', data: receipt }],
      },
    }, 'receipt-operation-transport')
    expect(accepted).toMatchObject({ kind: 'committed', operationId: 'receipt-operation' })
    expect((await post(harness, { action: 'snapshot', scope: 'results' }, 'receipt-results-accepted')).records)
      .toEqual([expect.objectContaining({ id: 'receipt-operation', scope: 'results', data: receipt })])

    const progress = {
      ...receipt,
      steps: [{ stepId: 'step-1', kind: 'claim-observation', book: 'personal', expectedRevisions: [], dependsOn: [], state: { kind: 'completed', destination: { id: 'event-1', revision: 'rev-1' }, completedAt: '2026-07-27T08:01:00.000Z' } }],
      state: { kind: 'completed', completedAt: '2026-07-27T08:01:00.000Z' },
    }
    const progressed = await post(harness, {
      action: 'command', operationId: 'receipt-progress-operation', expectedRevisions: [],
      contentDigest: 'receipt-progress-content', content: {
        kind: 'receipt-progress',
        writes: [{ scope: 'results', id: 'receipt-operation', data: progress }],
      },
    }, 'receipt-progress-transport')
    expect(progressed).toMatchObject({ kind: 'committed', operationId: 'receipt-progress-operation' })
    expect((await post(harness, { action: 'snapshot', scope: 'results' }, 'receipt-results-progress')).records)
      .toEqual([expect.objectContaining({ id: 'receipt-operation', data: progress })])
  })

  it('uses one stable link revision for the write outcome, snapshot, and retry', async () => {
    const payload = {
      action: 'record_link', operationId: 'stable-link-first',
      link: {
        linkId: 'stable-link-1', sourceId: 'event-source-1', destinationId: 'partner-event-1',
        destinationRevision: 'partner-revision-1', sourceRevision: 'personal-revision-1',
        status: 'active', origin: 'stable-link-test',
      },
    }
    const first = await post(harness, payload, 'stable-link-first-transport')
    const links = await post(harness, { action: 'snapshot', scope: 'links' }, 'stable-link-snapshot')
    const link = (links.records as Array<Record<string, unknown>>).find(record => record.id === 'stable-link-1')!

    expect(first).toMatchObject({
      kind: 'committed',
      destinations: [{ id: 'stable-link-1', revision: link.revision }],
    })

    const retry = await post(harness, {
      ...payload,
      operationId: 'stable-link-retry',
      expectedRevisions: [{ id: 'stable-link-1', revision: link.revision }],
    }, 'stable-link-retry-transport')
    expect(retry).toMatchObject({
      kind: 'committed',
      destinations: [{ id: 'stable-link-1', revision: link.revision }],
    })
  })

  it('rejects malformed new links while preserving valid replay and conflict behavior', async () => {
    await post(harness, { action: 'enable_e2' }, 'invalid-link-enable')
    const before = harness.spreadsheet.getSheetByName('跨簿連結')!.getLastRow()
    const missingSourceRevision = await post(harness, {
      action: 'record_link', operationId: 'invalid-link-source-revision', link: {
        linkId: 'invalid-link-source-revision', sourceId: 'source-1', destinationId: 'destination-1',
        sourceRevision: ' ', destinationRevision: 'destination-revision-1',
      },
    }, 'invalid-link-source-revision-transport')
    const missingDestinationRevision = await post(harness, {
      action: 'record_link', operationId: 'invalid-link-destination-revision', link: {
        linkId: 'invalid-link-destination-revision', sourceId: 'source-2', destinationId: 'destination-2',
        sourceRevision: 'source-revision-2', destinationRevision: '',
      },
    }, 'invalid-link-destination-revision-transport')

    expect(missingSourceRevision).toMatchObject({ kind: 'rejected', reason: 'invalid-link' })
    expect(missingDestinationRevision).toMatchObject({ kind: 'rejected', reason: 'invalid-link' })
    expect(harness.spreadsheet.getSheetByName('跨簿連結')!.getLastRow()).toBe(before)

    const payload = {
      action: 'record_link', operationId: 'valid-link-first', link: {
        linkId: 'valid-link-replay', sourceId: 'source-valid', destinationId: 'destination-valid',
        sourceRevision: 'source-revision-valid', destinationRevision: 'destination-revision-valid',
        status: 'active', origin: 'integration-test',
      },
    }
    const first = await post(harness, payload, 'valid-link-first-transport')
    const links = await post(harness, { action: 'snapshot', scope: 'links' }, 'valid-link-snapshot')
    const link = (links.records as Array<Record<string, unknown>>).find(record => record.id === 'valid-link-replay')!

    expect(link).toMatchObject({
      sourceRevision: 'source-revision-valid',
      destination: { id: 'destination-valid', revision: 'destination-revision-valid' },
    })
    expect(first).toMatchObject({ kind: 'committed', destinations: [{ id: 'valid-link-replay', revision: link.revision }] })

    const replay = await post(harness, {
      ...payload, operationId: 'valid-link-replay-operation',
      expectedRevisions: [{ id: 'valid-link-replay', revision: link.revision }],
    }, 'valid-link-replay-transport')
    expect(replay).toMatchObject({ kind: 'committed', destinations: [{ id: 'valid-link-replay', revision: link.revision }] })

    const changed = await post(harness, {
      ...payload, operationId: 'valid-link-conflict', link: {
        ...payload.link, sourceRevision: 'different-source-revision',
      },
    }, 'valid-link-conflict-transport')
    expect(changed).toMatchObject({ kind: 'conflict', reason: 'link-id-reused-with-different-content' })
  })

  it('rejects malformed new checkpoints while preserving valid replay and conflict behavior', async () => {
    await post(harness, { action: 'enable_e2' }, 'invalid-checkpoint-enable')
    const before = harness.spreadsheet.getSheetByName('對帳檢查點')!.getLastRow()
    const malformed = await post(harness, {
      action: 'accept_checkpoint', operationId: 'invalid-checkpoint-scope-version', checkpoint: {
        checkpointId: 'invalid-checkpoint-scope-version', cutoff: '2026-07-27', scopeVersion: ' ',
        evidenceIds: [],
      },
    }, 'invalid-checkpoint-scope-version-transport')

    expect(malformed).toMatchObject({ kind: 'rejected', reason: 'invalid-checkpoint' })
    expect(harness.spreadsheet.getSheetByName('對帳檢查點')!.getLastRow()).toBe(before)

    const payload = {
      action: 'accept_checkpoint', operationId: 'valid-checkpoint-first', checkpoint: {
        checkpointId: 'valid-checkpoint-replay', cutoff: '2026-07-27', scopeVersion: 'scope-version-valid',
        representedBalances: { TWD: '0' }, acceptedBalances: { TWD: '0' }, evidenceIds: [],
      },
    }
    const first = await post(harness, payload, 'valid-checkpoint-first-transport')
    const checkpoints = await post(harness, { action: 'snapshot', scope: 'checkpoints' }, 'valid-checkpoint-snapshot')
    const checkpoint = (checkpoints.records as Array<Record<string, unknown>>).find(record => record.id === 'valid-checkpoint-replay')!

    expect(checkpoint).toMatchObject({ scopeVersion: 'scope-version-valid' })
    expect(first).toMatchObject({ kind: 'committed', destinations: [{ id: 'valid-checkpoint-replay', revision: checkpoint.revision }] })

    const replay = await post(harness, {
      ...payload, operationId: 'valid-checkpoint-replay-operation',
      expectedRevisions: [{ id: 'valid-checkpoint-replay', revision: checkpoint.revision }],
    }, 'valid-checkpoint-replay-transport')
    expect(replay).toMatchObject({ kind: 'committed', destinations: [{ id: 'valid-checkpoint-replay', revision: checkpoint.revision }] })

    const changed = await post(harness, {
      ...payload, operationId: 'valid-checkpoint-conflict', checkpoint: {
        ...payload.checkpoint, scopeVersion: 'different-scope-version',
      },
    }, 'valid-checkpoint-conflict-transport')
    expect(changed).toMatchObject({ kind: 'conflict', reason: 'checkpoint-id-reused-with-different-content' })
  })

  it('preserves an external nested expected-revision conflict on an unknown manifest retry', async () => {
    const metric = await post(harness, {
      action: 'publish_result', operationId: 'nested-revision-target-op', result: {
        resultId: 'nested-revision-target', state: 'accepted', value: { total: '1' },
      },
    }, 'nested-revision-target-transport')
    expect(metric).toMatchObject({ kind: 'committed' })
    const initialResults = await post(harness, { action: 'snapshot', scope: 'results' }, 'nested-revision-target-snapshot')
    const target = (initialResults.records as Array<Record<string, unknown>>).find(record => record.resultId === 'nested-revision-target')!
    const payload = {
      action: 'accept_import', operationId: 'nested-revision-manifest', manifest: {
        manifestId: 'nested-revision-manifest', sourceEvidence: ['nested-revision-evidence'],
      }, steps: [{
        stepId: 'nested-step', disposition: 'create', state: 'completed',
        destinationId: 'nested-destination', destinationRevision: 'nested-destination-revision',
        expectedRevisions: [{ id: 'nested-revision-target', revision: target.revision }],
      }],
    }
    harness.spreadsheet.getSheetByName('匯入步驟')!.failNextSetValues('nested manifest step failed')
    expect(await post(harness, payload, 'nested-revision-first-transport')).toEqual({
      kind: 'unknown', operationId: 'nested-revision-manifest', reason: 'write-outcome-unknown',
    })

    await post(harness, {
      action: 'publish_result', operationId: 'nested-revision-target-change', result: {
        resultId: 'nested-revision-target', state: 'accepted', value: { total: '2' },
      },
    }, 'nested-revision-target-change-transport')

    const retry = await post(harness, payload, 'nested-revision-retry-transport')
    expect(retry).toMatchObject({
      kind: 'conflict', operationId: 'nested-revision-manifest', reason: 'stale-expected-revision',
      conflicts: [expect.objectContaining({ id: 'nested-revision-target' })],
    })
  })

  it('recovers a resume-import command with a manifest wrapper after a partial write', async () => {
    await post(harness, {
      action: 'accept_import', operationId: 'resume-wrapper-manifest', manifest: {
        manifestId: 'resume-wrapper-manifest', sourceEvidence: ['resume-wrapper-evidence'],
      }, steps: [{ stepId: 'pending', disposition: 'create', state: 'pending' }],
    }, 'resume-wrapper-manifest-transport')
    const payload = {
      action: 'command', operationId: 'resume-wrapper-operation', expectedRevisions: [], content: {
        kind: 'resume-import', manifest: {
          manifestId: 'resume-wrapper-manifest', steps: [{
            stepId: 'pending', state: 'completed', destinationId: 'resume-wrapper-destination',
            destinationRevision: 'resume-wrapper-destination-revision',
          }],
        },
      },
    }
    harness.spreadsheet.getSheetByName('匯入清單')!.failNextSetValues('resume manifest update failed')
    expect(await post(harness, payload, 'resume-wrapper-first-transport')).toEqual({
      kind: 'unknown', operationId: 'resume-wrapper-operation', reason: 'write-outcome-unknown',
    })

    const retry = await post(harness, payload, 'resume-wrapper-retry-transport')
    expect(retry).toMatchObject({ kind: 'committed', operationId: 'resume-wrapper-operation' })
    expect((await post(harness, { action: 'snapshot', scope: 'steps' }, 'resume-wrapper-step-snapshot')).records)
      .toEqual([expect.objectContaining({ manifestId: 'resume-wrapper-manifest', stepId: 'pending', state: 'completed' })])
  })

  it('types receipt results and excludes them from metric result invalidation', async () => {
    const receipt = {
      kind: 'import-receipt', operationId: 'typed-receipt', planId: 'typed-plan', contractVersion: CONTRACT_VERSION,
      actor: 'cheng', acceptedAt: '2026-07-27T08:00:00.000Z', contentDigest: 'typed-receipt-digest',
      steps: [{ stepId: 'typed-step', kind: 'claim-observation', book: 'personal', expectedRevisions: [], dependsOn: [], state: { kind: 'pending' } }],
      state: { kind: 'accepted' },
    }
    await post(harness, {
      action: 'command', operationId: 'typed-receipt', expectedRevisions: [], content: {
        kind: 'import-receipt', writes: [{ scope: 'results', id: 'typed-receipt', data: receipt }],
      },
    }, 'typed-receipt-transport')

    const journal = harness.spreadsheet.getSheetByName('日記帳')!
    journal.getRange(2, 1, 1, journalHeaders.length).setValues([[
      '2026-07-27', '12:00', '支出', '餐飲', '現金', '10', 'TWD', '餐飲',
      'typed-receipt-shop', 'typed receipt test', '', '', '00000000-0000-4000-8000-000000000930', 'import', '2026-07-27T12:00:00+08:00',
    ]])
    await post(harness, {
      action: 'publish_result', operationId: 'typed-metric', result: {
        resultId: 'typed-metric', dependencies: [{ id: '00000000-0000-4000-8000-000000000930' }],
        state: 'accepted', value: { total: '10' },
      },
    }, 'typed-metric-transport')
    await post(harness, {
      action: 'correct_event', operationId: 'typed-correction', txnId: '00000000-0000-4000-8000-000000000930',
      reversalTxnId: '00000000-0000-4000-8000-000000000931',
    }, 'typed-correction-transport')

    const results = await post(harness, { action: 'snapshot', scope: 'results' }, 'typed-results-snapshot')
    expect(results.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'typed-receipt', type: 'receipt', data: receipt }),
      expect.objectContaining({ resultId: 'typed-metric', type: 'metric', state: 'invalidated' }),
    ]))
    expect((results.records as Array<Record<string, unknown>>).filter(record => record.id === 'typed-receipt')).toHaveLength(1)
    expect(harness.spreadsheet.getSheetByName('結果版本')!.getLastRow()).toBe(3)
  })

  it('reserves receipt claims before attempting receipt result writes', async () => {
    await post(harness, { action: 'enable_e2' }, 'receipt-claim-fence-enable')
    harness.spreadsheet.getSheetByName('整合記錄')!.failNextSetValues('receipt result write failed')
    const failed = await post(harness, {
      action: 'command', operationId: 'receipt-claim-fence', expectedRevisions: [],
      claims: ['observation:receipt-fence'], content: {
        kind: 'import-receipt', claims: ['observation:receipt-fence'],
        writes: [{ scope: 'results', id: 'receipt-fence', data: {
          kind: 'import-receipt', operationId: 'receipt-fence', planId: 'fence-plan', contractVersion: CONTRACT_VERSION,
          actor: 'cheng', acceptedAt: '2026-07-27T08:00:00.000Z', contentDigest: 'fence-receipt-digest',
          steps: [{ stepId: 'fence-step', kind: 'claim-observation', book: 'personal', expectedRevisions: [], dependsOn: [], state: { kind: 'pending' } }],
          state: { kind: 'accepted' },
        } }],
      },
    }, 'receipt-claim-fence-transport')
    expect(failed).toEqual({ kind: 'unknown', operationId: 'receipt-claim-fence', reason: 'write-outcome-unknown' })
    expect((await post(harness, { action: 'snapshot', scope: 'claims' }, 'receipt-claim-fence-snapshot')).records)
      .toEqual([expect.objectContaining({ claimId: 'observation:receipt-fence', operationId: 'receipt-claim-fence', status: 'claimed' })])
  })

  it('rejects malformed receipts and refuses progress that changes approved identity', async () => {
    const malformed = await post(harness, {
      action: 'command', operationId: 'malformed-receipt', expectedRevisions: [], content: {
        kind: 'import-receipt',
        writes: [{ scope: 'results', id: 'malformed-receipt', data: { operationId: 'malformed-receipt' } }],
      },
    }, 'malformed-receipt-transport')
    expect(malformed).toMatchObject({ kind: 'rejected', reason: 'invalid-receipt' })
    expect((await post(harness, { action: 'snapshot', scope: 'results' }, 'malformed-receipt-snapshot')).records).toEqual([])

    const receipt = {
      operationId: 'immutable-receipt', planId: 'immutable-plan', contractVersion: CONTRACT_VERSION,
      actor: 'cheng', acceptedAt: '2026-07-27T08:00:00.000Z', contentDigest: 'immutable-digest',
      steps: [{ stepId: 'immutable-step', kind: 'claim-observation', book: 'personal', expectedRevisions: [], dependsOn: [], state: { kind: 'pending' } }],
      state: { kind: 'accepted' },
    }
    expect(await post(harness, {
      action: 'command', operationId: 'immutable-receipt', expectedRevisions: [], content: {
        kind: 'import-receipt', writes: [{ scope: 'results', id: 'immutable-receipt', data: receipt }],
      },
    }, 'immutable-receipt-first')).toMatchObject({ kind: 'committed' })
    const changed = await post(harness, {
      action: 'command', operationId: 'immutable-receipt-progress', expectedRevisions: [], content: {
        kind: 'receipt-progress', writes: [{
          scope: 'results', id: 'immutable-receipt', data: {
            ...receipt, planId: 'different-plan', state: { kind: 'in-progress' },
          },
        }],
      },
    }, 'immutable-receipt-progress')
    expect(changed).toMatchObject({ kind: 'rejected', reason: 'receipt-progress-regression' })

    const definitionReceipt = {
      operationId: 'definition-receipt', planId: 'definition-plan', contractVersion: CONTRACT_VERSION,
      actor: 'cheng', acceptedAt: '2026-07-27T08:00:00.000Z', contentDigest: 'definition-digest',
      steps: [{
        stepId: 'definition-step', kind: 'claim-observation', book: 'personal',
        expectedRevisions: [{ id: 'source-1', revision: 'rev-1' }], dependsOn: ['prior-step'],
        state: { kind: 'pending' },
      }],
      state: { kind: 'accepted' },
    }
    expect(await post(harness, {
      action: 'command', operationId: 'definition-receipt', expectedRevisions: [], content: {
        kind: 'import-receipt', writes: [{ scope: 'results', id: 'definition-receipt', data: definitionReceipt }],
      },
    }, 'definition-receipt-first')).toMatchObject({ kind: 'committed' })
    const definitionChanged = await post(harness, {
      action: 'command', operationId: 'definition-receipt-progress', expectedRevisions: [], content: {
        kind: 'receipt-progress', writes: [{
          scope: 'results', id: 'definition-receipt', data: {
            ...definitionReceipt,
            steps: [{ ...definitionReceipt.steps[0], kind: 'create-event-group', state: { kind: 'unknown', reason: 'uncertain' } }],
            state: { kind: 'in-progress' },
          },
        }],
      },
    }, 'definition-receipt-progress')
    expect(definitionChanged).toMatchObject({ kind: 'rejected', reason: 'receipt-progress-regression' })

    const incompleteReceipt = {
      operationId: 'incomplete-receipt', planId: 'incomplete-plan', contractVersion: CONTRACT_VERSION,
      actor: 'cheng', acceptedAt: '2026-07-27T08:00:00.000Z', contentDigest: 'incomplete-digest',
      steps: [{
        stepId: 'incomplete-step', kind: 'claim-observation', book: 'personal',
        expectedRevisions: [], dependsOn: [], state: {
          kind: 'unknown', reason: 'write-outcome-unknown', destinations: [
            { id: 'destination-a', revision: 'revision-a' }, { id: 'destination-b', revision: 'revision-b' },
          ],
        },
      }],
      state: { kind: 'incomplete', reason: 'write-outcome-unknown' },
    }
    expect(await post(harness, {
      action: 'command', operationId: 'incomplete-receipt', expectedRevisions: [], content: {
        kind: 'import-receipt', writes: [{ scope: 'results', id: 'incomplete-receipt', data: incompleteReceipt }],
      },
    }, 'incomplete-receipt-first')).toMatchObject({ kind: 'committed' })
    const incompleteDestinationDropped = await post(harness, {
      action: 'command', operationId: 'incomplete-receipt-progress', expectedRevisions: [], content: {
        kind: 'receipt-progress', writes: [{
          scope: 'results', id: 'incomplete-receipt', data: {
            ...incompleteReceipt,
            steps: [{
              ...incompleteReceipt.steps[0],
              state: { kind: 'completed', destination: { id: 'destination-a', revision: 'revision-a' }, completedAt: '2026-07-27T08:02:00.000Z' },
            }],
            state: { kind: 'completed', completedAt: '2026-07-27T08:02:00.000Z' },
          },
        }],
      },
    }, 'incomplete-receipt-progress')
    expect(incompleteDestinationDropped).toMatchObject({ kind: 'rejected', reason: 'receipt-progress-regression' })
  })

  it('includes durable E2 links in pinned lookup results', async () => {
    await post(harness, { action: 'enable_e2' }, 'link-lookup-enable')
    const linked = await post(harness, {
      action: 'record_link', operationId: 'link-operation',
      link: {
        linkId: 'link-lookup-1', sourceId: 'event-source-1', destinationId: 'partner-event-1',
        destinationRevision: 'partner-revision-1', sourceRevision: 'personal-revision-1',
        status: 'active', origin: 'synthetic-test',
      },
    }, 'link-lookup-record')
    expect(linked).toMatchObject({ kind: 'committed' })

    const links = await post(harness, { action: 'snapshot', scope: 'links' }, 'link-lookup-snapshot')
    const lookup = await post(harness, {
      action: 'lookup', ids: ['link-lookup-1'], snapshotRevision: links.snapshotRevision,
    }, 'link-lookup-read')
    expect(lookup).toMatchObject({ kind: 'ok', records: [expect.objectContaining({ linkId: 'link-lookup-1' })] })
  })

  it('uses canonical content for operation conflicts even when the transport digest is forged', async () => {
    const first = await post(harness, {
      action: 'command', operationId: 'canonical-content-op', expectedRevisions: [],
      contentDigest: 'same-forged-digest', content: {
        kind: 'claims', claims: ['observation:canonical'],
      },
    }, 'canonical-content-first')
    expect(first).toMatchObject({ kind: 'committed' })
    const changed = await post(harness, {
      action: 'command', operationId: 'canonical-content-op', expectedRevisions: [],
      contentDigest: 'same-forged-digest', content: {
        kind: 'claims', claims: ['observation:canonical-changed'],
      },
    }, 'canonical-content-changed')
    expect(changed).toMatchObject({ kind: 'conflict', reason: 'operation-id-reused-with-different-content' })
  })

  it('refuses a command whose destination revision is stale before any write', async () => {
    const before = journalRows(harness).length
    const stale = await post(harness, {
      action: 'command', operationId: 'stale-destination-command',
      expectedRevisions: [{ id: 'event:missing', revision: 'revision-before-edit' }],
      contentDigest: 'stale-destination-content',
      content: {
        kind: 'claims',
        claims: ['observation:must-not-write'],
      },
    }, 'stale-destination-transport')

    expect(stale).toMatchObject({
      kind: 'conflict',
      operationId: 'stale-destination-command',
      reason: 'stale-expected-revision',
      conflicts: [{ id: 'event:missing', expected: 'revision-before-edit', actual: 'missing' }],
    })
    expect(journalRows(harness)).toHaveLength(before)
    expect(await post(harness, { action: 'snapshot', scope: 'claims' }, 'stale-destination-claims-snapshot'))
      .toMatchObject({ records: [] })
  })

  it('requires conversion evidence for mixed native currencies', async () => {
    const rejected = await post(harness, {
      action: 'create_event_group', operationId: 'group-missing-fx', group: {
        groupId: 'group-missing-fx', legs: [
          { txnId: '00000000-0000-4000-8000-000000000911', date: '2026-07-27', type: '轉帳', debitAccount: '銀行', creditAccount: '現金', amount: '3200', currency: 'TWD' },
          { txnId: '00000000-0000-4000-8000-000000000912', date: '2026-07-27', type: '轉帳', debitAccount: '現金', creditAccount: '銀行', amount: '100', currency: 'USD' },
        ],
        currencyTotals: [
          { currency: 'TWD', debit: '3200', credit: '3200' },
          { currency: 'USD', debit: '100', credit: '100' },
        ],
      },
    }, 'group-missing-fx-transport')
    expect(rejected).toMatchObject({ kind: 'rejected', reason: 'group-conversion-evidence-required' })

    const conversionOnly = await post(harness, {
      action: 'create_event_group', operationId: 'group-conversion-only', group: {
        groupId: 'group-conversion-only', conversionReference: 'fx:conversion-only', currencyTotals: [
          { currency: 'TWD', debit: '3200', credit: '3200' }, { currency: 'USD', debit: '100', credit: '100' },
        ], legs: [
          { txnId: '00000000-0000-4000-8000-000000000916', date: '2026-07-27', type: '轉帳', debitAccount: '銀行', creditAccount: '現金', amount: '3200', currency: 'TWD' },
          { txnId: '00000000-0000-4000-8000-000000000917', date: '2026-07-27', type: '轉帳', debitAccount: '現金', creditAccount: '銀行', amount: '100', currency: 'USD' },
        ],
      },
    }, 'group-conversion-only-transport')
    expect(conversionOnly).toMatchObject({ kind: 'rejected', reason: 'group-conversion-evidence-required' })

    const clearingOnly = await post(harness, {
      action: 'create_event_group', operationId: 'group-clearing-only', group: {
        groupId: 'group-clearing-only', clearingReference: 'clearing:only', currencyTotals: [
          { currency: 'TWD', debit: '3200', credit: '3200' }, { currency: 'USD', debit: '100', credit: '100' },
        ], legs: [
          { txnId: '00000000-0000-4000-8000-000000000918', date: '2026-07-27', type: '轉帳', debitAccount: '銀行', creditAccount: '現金', amount: '3200', currency: 'TWD' },
          { txnId: '00000000-0000-4000-8000-000000000919', date: '2026-07-27', type: '轉帳', debitAccount: '現金', creditAccount: '銀行', amount: '100', currency: 'USD' },
        ],
      },
    }, 'group-clearing-only-transport')
    expect(clearingOnly).toMatchObject({ kind: 'rejected', reason: 'group-conversion-evidence-required' })
  })

  it('posts the reviewed cutover difference and preserves the no-pre-cutover claim', async () => {
    const evidence = await post(harness, {
      action: 'record_evidence', operationId: 'evidence-op', evidence: {
        evidenceId: 'evidence-1', sourceReference: 'synthetic:balance', contentDigest: 'd'.repeat(64), effectiveDate: '2026-07-27',
      },
    }, 'evidence-op-transport')
    expect(evidence).toMatchObject({ kind: 'committed' })
    const journal = harness.spreadsheet.getSheetByName('日記帳')!
    journal.getRange(2, 1, 1, journalHeaders.length).setValues([[
      '2026-07-26', '12:00', '轉帳', '現金', '期初餘額', '2000', 'TWD', '',
      '', 'represented history', '', '', '00000000-0000-4000-8000-000000000907', 'import', '2026-07-26T12:00:00+08:00',
    ]])
    journal.getRange(3, 1, 1, journalHeaders.length).setValues([[
      '2026-07-28', '12:00', '轉帳', '現金', '期初餘額', '9000', 'TWD', '',
      '', 'future history excluded from cutoff', '', '', '00000000-0000-4000-8000-000000000913', 'import', '2026-07-28T12:00:00+08:00',
    ]])
    const adjustment = await post(harness, {
      action: 'opening_adjustment', operationId: 'opening-op', adjustment: {
        checkpointId: 'cutover-1', account: '現金', currency: 'TWD', date: '2026-07-27',
        representedBalance: '2000', acceptedBalance: '10000', evidenceIds: ['evidence-1'],
        txnId: '00000000-0000-4000-8000-000000000920',
      },
    }, 'opening-op-transport')
    expect(adjustment).toMatchObject({ kind: 'committed' })
    const accounts = await post(harness, { action: 'snapshot', scope: 'accounts' }, 'opening-snapshot')
    expect(accounts.records).toContainEqual(expect.objectContaining({ name: '現金', balances: [{ amount: '19000', currency: 'TWD' }] }))
    const checkpoints = await post(harness, { action: 'snapshot', scope: 'checkpoints' }, 'checkpoint-snapshot')
    expect(checkpoints.records).toContainEqual(expect.objectContaining({
      checkpointId: 'cutover-1', adjustment: { amount: '8000', currency: 'TWD', account: '現金' },
      coverage: { kind: 'cutover-only', preCutoverCoverage: false, throughFinancialDate: '2026-07-27' },
    }))
    expect(harness.spreadsheet.getSheetByName('對帳檢查點')!.getLastRow()).toBe(3)
  })

  it('resumes an opening adjustment after the checkpoint was durable but the journal write failed', async () => {
    await post(harness, {
      action: 'record_evidence', operationId: 'opening-resume-evidence', evidence: {
        evidenceId: 'opening-resume-evidence-1', sourceReference: 'synthetic:resume', contentDigest: 'e'.repeat(64), effectiveDate: '2026-07-27',
      },
    }, 'opening-resume-evidence-transport')
    const journal = harness.spreadsheet.getSheetByName('日記帳')!
    journal.getRange(2, 1, 1, journalHeaders.length).setValues([[
      '2026-07-26', '12:00', '轉帳', '現金', '期初餘額', '2000', 'TWD', '',
      '', 'represented history', '', '', '00000000-0000-4000-8000-000000000914', 'import', '2026-07-26T12:00:00+08:00',
    ]])
    journal.failNextSetValues('opening journal failure')
    const adjustment = {
      checkpointId: 'cutover-resume', account: '現金', currency: 'TWD', date: '2026-07-27',
      representedBalance: '2000', acceptedBalance: '10000', evidenceIds: ['opening-resume-evidence-1'],
      txnId: '00000000-0000-4000-8000-000000000915',
    }
    const first = await post(harness, { action: 'opening_adjustment', operationId: 'opening-resume-first', adjustment }, 'opening-resume-first-transport')
    expect(first).toEqual({ kind: 'unknown', operationId: 'opening-resume-first', reason: 'write-outcome-unknown' })
    expect((await post(harness, { action: 'snapshot', scope: 'checkpoints' }, 'opening-resume-pending-snapshot')).records).toContainEqual(expect.objectContaining({ checkpointId: 'cutover-resume', status: 'pending' }))
    const resumed = await post(harness, { action: 'opening_adjustment', operationId: 'opening-resume-second', adjustment }, 'opening-resume-second-transport')
    expect(resumed).toMatchObject({ kind: 'committed' })
    const rows = journal.getRange(2, 1, journal.getLastRow() - 1, journalHeaders.length).getValues()
    expect(rows.filter(row => row[12] === '00000000-0000-4000-8000-000000000915')).toHaveLength(1)
    expect((await post(harness, { action: 'snapshot', scope: 'checkpoints' }, 'opening-resume-accepted-snapshot')).records).toContainEqual(expect.objectContaining({ checkpointId: 'cutover-resume', status: 'accepted' }))
  })

  it('keeps corrections append-only and references the original row', async () => {
    const journal = harness.spreadsheet.getSheetByName('日記帳')!
    journal.getRange(2, 1, 1, journalHeaders.length).setValues([[
      '2026-07-27', '12:00', '支出', '餐飲', '現金', '10', 'TWD', '餐飲',
      '月球雜貨店', 'original', '', '', '00000000-0000-4000-8000-000000000908', 'import', '2026-07-27T12:00:00+08:00',
    ]])
    const original = journal.getRange(2, 1, 1, journalHeaders.length).getValues()[0]
    const result = await post(harness, {
      action: 'publish_result', operationId: 'correction-dependent-result', result: {
        resultId: 'dependent-result', interval: { from: '2026-07-01', to: '2026-07-27' },
        dependencies: [{ id: '00000000-0000-4000-8000-000000000908', revision: 'before-correction' }],
        state: 'accepted', value: { total: '10' },
      },
    }, 'correction-dependent-result-transport')
    expect(result).toMatchObject({ kind: 'committed' })
    const correction = await post(harness, {
      action: 'correct_event', operationId: 'correction-op', txnId: '00000000-0000-4000-8000-000000000908',
      reversalTxnId: '00000000-0000-4000-8000-000000000909', replacementTxnId: '00000000-0000-4000-8000-000000000910',
      replacement: { debitAccount: '餐飲', creditAccount: '現金', amount: '12', currency: 'TWD', category: '餐飲' },
    }, 'correction-op-transport')
    expect(correction).toMatchObject({ kind: 'committed' })
    expect(journal.getRange(2, 1, 1, journalHeaders.length).getValues()[0]).toEqual(original)
    const rows = journal.getRange(2, 1, journal.getLastRow() - 1, journalHeaders.length).getValues()
    expect(rows).toEqual(expect.arrayContaining([
      expect.arrayContaining(['00000000-0000-4000-8000-000000000909']),
      expect.arrayContaining(['00000000-0000-4000-8000-000000000910']),
    ]))
    const events = await post(harness, { action: 'snapshot', scope: 'events' }, 'correction-events-snapshot')
    expect(events.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '00000000-0000-4000-8000-000000000908' }),
      expect.objectContaining({ id: '00000000-0000-4000-8000-000000000909', reversalTxnId: '00000000-0000-4000-8000-000000000908' }),
    ]))

    const retry = await post(harness, {
      action: 'correct_event', operationId: 'correction-retry-op', txnId: '00000000-0000-4000-8000-000000000908',
      reversalTxnId: '00000000-0000-4000-8000-000000000909', replacementTxnId: '00000000-0000-4000-8000-000000000910',
      replacement: { debitAccount: '餐飲', creditAccount: '現金', amount: '12', currency: 'TWD', category: '餐飲' },
    }, 'correction-retry-transport')
    expect(retry).toMatchObject({ kind: 'committed', destinations: expect.arrayContaining([
      expect.objectContaining({ id: '00000000-0000-4000-8000-000000000909' }),
      expect.objectContaining({ id: '00000000-0000-4000-8000-000000000910' }),
    ]) })
    const rowsAfterRetry = journal.getRange(2, 1, journal.getLastRow() - 1, journalHeaders.length).getValues()
    expect(rowsAfterRetry.filter(row => row[12] === '00000000-0000-4000-8000-000000000909')).toHaveLength(1)
    expect(rowsAfterRetry.filter(row => row[12] === '00000000-0000-4000-8000-000000000910')).toHaveLength(1)

    const changedRetry = await post(harness, {
      action: 'correct_event', operationId: 'correction-changed-retry-op', txnId: '00000000-0000-4000-8000-000000000908',
      reversalTxnId: '00000000-0000-4000-8000-000000000909', replacementTxnId: '00000000-0000-4000-8000-000000000910',
      replacement: { debitAccount: '餐飲', creditAccount: '現金', amount: '13', currency: 'TWD', category: '餐飲' },
    }, 'correction-changed-retry-transport')
    expect(changedRetry).toMatchObject({ kind: 'conflict', reason: 'correction-id-reused-with-different-content' })
    const resultSnapshot = await post(harness, { action: 'snapshot', scope: 'results' }, 'correction-results-snapshot')
    expect(resultSnapshot.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ resultId: 'dependent-result', state: 'invalidated' }),
    ]))
  })
})

async function post(harness: FakeGasHarness, payload: Record<string, unknown>, nonce: string): Promise<Record<string, unknown>> {
  const envelope = await buildEnvelope(secret, { ...payload, contractVersion: CONTRACT_VERSION }, Math.floor(fixedNow.getTime() / 1000), nonce)
  const output: FakeTextOutput = harness.doPost({ postData: { contents: JSON.stringify(envelope) } })
  return JSON.parse(output.getContent()) as Record<string, unknown>
}

function journalRows(harness: FakeGasHarness): unknown[][] {
  const journal = harness.spreadsheet.getSheetByName('日記帳')!
  if (journal.getLastRow() < 2) return []
  return journal.getRange(2, 1, journal.getLastRow() - 1, journalHeaders.length).getValues()
}
