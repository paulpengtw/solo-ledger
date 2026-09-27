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
      contentDigest: 'digest-plan-0001', content: {
        claims: ['observation:one'],
        writes: [{ scope: 'records', id: 'event:a', data: { amount: '10', currency: 'TWD' } }],
      },
    }, 'claim-a-transport')
    expect(first).toMatchObject({ kind: 'committed', operationId: 'claim-a' })

    const second = await post(harness, {
      action: 'command', operationId: 'claim-b', expectedRevisions: [],
      contentDigest: 'digest-plan-0002', content: { claims: ['observation:one'] },
    }, 'claim-b-transport')
    expect(second).toMatchObject({ kind: 'conflict', reason: 'observation-already-claimed' })

    harness.advanceCacheTime(601)
    expect(await post(harness, {
      action: 'outcome', operationId: 'claim-a',
    }, 'claim-outcome-transport')).toMatchObject({ kind: 'committed', operationId: 'claim-a' })

    const changed = await post(harness, {
      action: 'command', operationId: 'claim-a', expectedRevisions: [],
      contentDigest: 'digest-plan-changed', content: { claims: ['observation:one'] },
    }, 'claim-a-changed-transport')
    expect(changed).toMatchObject({ kind: 'conflict', reason: 'operation-id-reused-with-different-content' })
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
      action: 'create_event_group', operationId: 'group-complete', group: {
        groupId: 'group-complete', legs: [
          { txnId: '00000000-0000-4000-8000-000000000901', date: '2026-07-27', type: '轉帳', debitAccount: '銀行', creditAccount: '現金', amount: '3200', currency: 'TWD' },
          { txnId: '00000000-0000-4000-8000-000000000902', date: '2026-07-27', type: '費用', debitAccount: '餐飲', creditAccount: '現金', amount: '10', currency: 'TWD' },
          { txnId: '00000000-0000-4000-8000-000000000903', date: '2026-07-27', type: '轉帳', debitAccount: '現金', creditAccount: '銀行', amount: '100', currency: 'USD' },
        ],
        currencyTotals: [
          { currency: 'TWD', debit: '3210', credit: '3210' },
          { currency: 'USD', debit: '100', credit: '100' },
        ],
      },
    }, 'group-complete-transport')
    expect(complete).toMatchObject({ kind: 'committed' })
    const groups = await post(harness, { action: 'snapshot', scope: 'groups' }, 'group-snapshot')
    expect(groups.records).toEqual([expect.objectContaining({
      id: 'group-complete', status: 'complete', completion: { kind: 'complete', marker: expect.any(String) },
    })])

    harness.spreadsheet.getSheetByName('日記帳')!.failNextSetValues('simulated group leg failure')
    const failed = await post(harness, {
      action: 'create_event_group', operationId: 'group-incomplete', group: {
        groupId: 'group-incomplete', legs: [
          { txnId: '00000000-0000-4000-8000-000000000904', date: '2026-07-27', type: '轉帳', debitAccount: '銀行', creditAccount: '現金', amount: '10', currency: 'TWD' },
          { txnId: '00000000-0000-4000-8000-000000000905', date: '2026-07-27', type: '轉帳', debitAccount: '現金', creditAccount: '銀行', amount: '5', currency: 'TWD' },
        ],
      },
    }, 'group-incomplete-transport')
    expect(failed).toEqual({ kind: 'unknown', operationId: 'group-incomplete', reason: 'write-outcome-unknown' })
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
      '', 'pending', '', '', '00000000-0000-4000-8000-000000000904', 'integration', '2026-07-27T12:00:00+08:00',
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
    const pendingSnapshot = await post(harness, { action: 'snapshot', scope: 'events' }, 'confirm-pending-snapshot')
    expect(pendingSnapshot.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: '00000000-0000-4000-8000-000000000904',
        category: '餐飲', reviewState: 'pending', review_state: 'pending',
        review: expect.objectContaining({ state: 'pending', category: '餐飲', confirmedAt: null }),
      }),
    ]))
    const confirmed = await post(harness, {
      action: 'confirm_event', operationId: 'confirm-ok', txnId: '00000000-0000-4000-8000-000000000904', category: '餐飲', confirmed: true,
    }, 'confirm-ok-transport')
    expect(confirmed).toMatchObject({ kind: 'committed' })
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
      action: 'accept_import', operationId: 'manifest-op', manifest: {
        manifestId: 'manifest-1', sourceEvidence: ['evidence-1'],
      }, steps: [
        { stepId: 'one', disposition: 'create', state: 'completed', destinationId: 'event-1', destinationRevision: 'rev-1' },
        { stepId: 'two', disposition: 'create', state: 'pending' },
        { stepId: 'three', disposition: 'link', state: 'conflicting' },
      ],
    }, 'manifest-op-transport')
    expect(accepted).toMatchObject({ kind: 'committed' })
    const manifests = await post(harness, { action: 'snapshot', scope: 'manifests' }, 'manifest-snapshot')
    const steps = await post(harness, { action: 'snapshot', scope: 'steps' }, 'step-snapshot')
    expect(manifests.records).toEqual([expect.objectContaining({ manifestId: 'manifest-1', status: 'accepted' })])
    expect(steps.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ stepId: 'one', state: 'completed', destination: { id: 'event-1', revision: 'rev-1' } }),
      expect.objectContaining({ stepId: 'two', state: 'pending' }),
      expect.objectContaining({ stepId: 'three', state: 'conflicting' }),
    ]))
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
      '', 'represented history', '', '', '00000000-0000-4000-8000-000000000907', 'integration', '2026-07-26T12:00:00+08:00',
    ]])
    const adjustment = await post(harness, {
      action: 'opening_adjustment', operationId: 'opening-op', adjustment: {
        checkpointId: 'cutover-1', account: '現金', currency: 'TWD', date: '2026-07-27',
        representedBalance: '2000', acceptedBalance: '10000', evidenceIds: ['evidence-1'],
      },
    }, 'opening-op-transport')
    expect(adjustment).toMatchObject({ kind: 'committed' })
    const accounts = await post(harness, { action: 'snapshot', scope: 'accounts' }, 'opening-snapshot')
    expect(accounts.records).toContainEqual(expect.objectContaining({ name: '現金', balances: [{ amount: '10000', currency: 'TWD' }] }))
    const checkpoints = await post(harness, { action: 'snapshot', scope: 'checkpoints' }, 'checkpoint-snapshot')
    expect(checkpoints.records).toContainEqual(expect.objectContaining({
      checkpointId: 'cutover-1', adjustment: { amount: '8000', currency: 'TWD', account: '現金' },
      coverage: { kind: 'cutover-only', preCutoverCoverage: false, throughFinancialDate: '2026-07-27' },
    }))
  })

  it('keeps corrections append-only and references the original row', async () => {
    const journal = harness.spreadsheet.getSheetByName('日記帳')!
    journal.getRange(2, 1, 1, journalHeaders.length).setValues([[
      '2026-07-27', '12:00', '支出', '餐飲', '現金', '10', 'TWD', '餐飲',
      '月球雜貨店', 'original', '', '', '00000000-0000-4000-8000-000000000908', 'integration', '2026-07-27T12:00:00+08:00',
    ]])
    const original = journal.getRange(2, 1, 1, journalHeaders.length).getValues()[0]
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
  })
})

async function post(harness: FakeGasHarness, payload: Record<string, unknown>, nonce: string): Promise<Record<string, unknown>> {
  const envelope = await buildEnvelope(secret, { ...payload, contractVersion: CONTRACT_VERSION }, Math.floor(fixedNow.getTime() / 1000), nonce)
  const output: FakeTextOutput = harness.doPost({ postData: { contents: JSON.stringify(envelope) } })
  return JSON.parse(output.getContent()) as Record<string, unknown>
}
