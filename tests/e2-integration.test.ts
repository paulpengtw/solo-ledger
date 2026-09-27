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
