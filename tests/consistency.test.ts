import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
} from 'jose'
import { buildEnvelope } from '../functions/lib/envelope'
import { handleAction, type Env } from '../functions/lib/handler'
import {
  loadGasFunctionsWithFakeGas,
  type FakeDriveFile,
  type FakeGasHarness,
  type FakeSheet,
  type FakeTextOutput,
} from './helpers/gas'

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
] as const

const ruleNames = [
  'unknown_or_disabled_accounts',
  'category_nominal_leg_mismatch',
  'settlement_status_mismatch',
  'stale_status_cells',
  'non_positive_amounts',
  'non_text_date_time_cells',
  'stray_cells_below_data_range',
  'reversals_missing_link',
  'linked_currency_mismatch',
] as const

type RuleName = typeof ruleNames[number]
type JournalRow = Record<string, unknown>
type Offense = {
  row: number
  field: string
  value: unknown
  expected?: unknown
  repairable?: boolean
  repaired?: boolean
  linked_row?: number
}
type RuleReport = {
  clean: boolean
  offenses: Offense[]
}
type ConsistencyReport = {
  ok: true
  clean: boolean
  repair_requested: boolean
  repaired: number
  rules: Record<RuleName, RuleReport>
}

describe('check_consistency', () => {
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

  it.each([
    ['unknown', '幽靈帳戶', false],
    ['disabled', '現金', true],
  ])(
    'reports the row and value for an %s journal account',
    async (_kind, account, disableAccount) => {
      if (disableAccount) {
        setAccountEnabled(harness, account, false)
      }
      appendJournalRows(harness, [
        cleanExpense('account-corruption', { 貸方帳戶: account }),
      ])

      const report = await postCheckConsistency(harness)

      expect(
        report.rules.unknown_or_disabled_accounts.offenses,
      ).toContainEqual(
        expect.objectContaining({
          row: 2,
          field: '貸方帳戶',
          value: account,
        }),
      )
    },
  )

  it('reports 分類 that disagrees with the row nominal leg', async () => {
    appendJournalRows(harness, [
      cleanExpense('category-corruption', { 分類: '交通' }),
    ])

    const report = await postCheckConsistency(harness)

    expect(report.rules.category_nominal_leg_mismatch.offenses).toContainEqual(
      expect.objectContaining({
        row: 2,
        field: '分類',
        value: '交通',
        expected: '餐飲',
      }),
    )
  })

  it('reports 結清狀態 that disagrees with derived outstanding', async () => {
    appendJournalRows(harness, [
      receivable('status-corruption', 100, { 結清狀態: '已結' }),
    ])

    const report = await postCheckConsistency(harness)

    expect(
      report.rules.settlement_status_mismatch.offenses,
    ).toContainEqual(
      expect.objectContaining({
        row: 2,
        field: '結清狀態',
        value: '已結',
        expected: '未結',
      }),
    )
  })

  it('reports a stale status cell as repairable after arithmetic has closed it', async () => {
    appendJournalRows(harness, [
      receivable('stale-status', 100),
      settlement('settle-stale-status', 'stale-status', 100),
    ])

    const report = await postCheckConsistency(harness)

    expect(report.rules.stale_status_cells.offenses).toContainEqual(
      expect.objectContaining({
        row: 2,
        field: '結清狀態',
        value: '未結',
        expected: '已結',
        repairable: true,
        repaired: false,
      }),
    )
  })

  it('reports a non-positive 金額 at its journal row', async () => {
    appendJournalRows(harness, [
      cleanExpense('zero-amount', { 金額: 0 }),
    ])

    const report = await postCheckConsistency(harness)

    expect(report.rules.non_positive_amounts.offenses).toContainEqual(
      expect.objectContaining({
        row: 2,
        field: '金額',
        value: 0,
      }),
    )
  })

  it('reports non-text 日期 and 時間 cells separately', async () => {
    appendJournalRows(harness, [
      cleanExpense('non-text-date-time', {
        日期: new Date('2026-07-26T00:00:00.000Z'),
        時間: 1230,
      }),
    ])

    const report = await postCheckConsistency(harness)

    expect(report.rules.non_text_date_time_cells.offenses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          row: 2,
          field: '日期',
          value: '2026-07-26T00:00:00.000Z',
        }),
        expect.objectContaining({
          row: 2,
          field: '時間',
          value: 1230,
        }),
      ]),
    )
  })

  it('reports a populated cell after the contiguous journal data ends', async () => {
    appendJournalRows(harness, [cleanExpense('before-gap')])
    requiredSheet(harness, '日記帳')
      .getRange(4, journalHeaders.indexOf('說明') + 1)
      .setValues([['掉在資料下方']])

    const report = await postCheckConsistency(harness)

    expect(report.rules.stray_cells_below_data_range.offenses).toContainEqual(
      expect.objectContaining({
        row: 4,
        field: '說明',
        value: '掉在資料下方',
      }),
    )
  })

  it('reports every populated cell in a complete row after a blank gap', async () => {
    appendJournalRows(harness, [cleanExpense('before-complete-gap')])
    const journal = requiredSheet(harness, '日記帳')
    const strayRow = cleanExpense('complete-row-after-gap')
    journal
      .getRange(4, 1, 1, journalHeaders.length)
      .setValues([
        journalHeaders.map(header => strayRow[header] ?? ''),
      ])

    const report = await postCheckConsistency(harness)

    expect(report.rules.stray_cells_below_data_range.offenses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ row: 4, field: '日期', value: '2026-07-26' }),
        expect.objectContaining({
          row: 4,
          field: 'txn_id',
          value: 'complete-row-after-gap',
        }),
      ]),
    )
  })

  it('reports an 沖銷 row with no 沖銷txn_id', async () => {
    appendJournalRows(harness, [
      reversal('missing-reversal-link', '', 'TWD'),
    ])

    const report = await postCheckConsistency(harness)

    expect(report.rules.reversals_missing_link.offenses).toContainEqual({
      row: 2,
      field: '沖銷txn_id',
      value: '',
    })
  })

  it.each([
    [
      'settlement',
      (originalId: string) =>
        settlement('foreign-settlement', originalId, 100, 'USD'),
    ],
    [
      'reversal',
      (originalId: string) =>
        reversal('foreign-reversal', originalId, 'USD'),
    ],
  ])(
    'reports linked currency mismatch on a %s row',
    async (_kind, linkedRowFactory) => {
      appendJournalRows(harness, [
        cleanExpense('currency-original'),
        linkedRowFactory('currency-original'),
      ])

      const report = await postCheckConsistency(harness)

      expect(report.rules.linked_currency_mismatch.offenses).toContainEqual(
        expect.objectContaining({
          row: 3,
          field: '幣別',
          value: 'USD',
          expected: 'TWD',
          linked_row: 2,
        }),
      )
    },
  )

  it('does not flag blank 分類 on a 轉帳 row with no nominal leg', async () => {
    appendJournalRows(harness, [transfer('plain-transfer')])

    const report = await postCheckConsistency(harness)

    expect(report.rules.category_nominal_leg_mismatch).toEqual({
      clean: true,
      offenses: [],
    })
  })

  it('does not check a row whose 結清狀態 is blank', async () => {
    appendJournalRows(harness, [cleanExpense('blank-status')])

    const report = await postCheckConsistency(harness)

    expect(report.rules.settlement_status_mismatch).toEqual({
      clean: true,
      offenses: [],
    })
    expect(report.rules.stale_status_cells).toEqual({
      clean: true,
      offenses: [],
    })
  })

  it('checks a status-bearing 手動 row regardless of 來源', async () => {
    appendJournalRows(harness, [
      receivable('', 80, {
        來源: '手動',
        結清狀態: '已結',
      }),
    ])

    const report = await postCheckConsistency(harness)

    expect(
      report.rules.settlement_status_mismatch.offenses,
    ).toContainEqual(
      expect.objectContaining({
        row: 2,
        value: '已結',
        expected: '未結',
      }),
    )
  })

  it('repairs the stale status with the derived value and changes no other cell', async () => {
    appendJournalRows(harness, [
      receivable('repair-target', 100),
      settlement('repair-settlement', 'repair-target', 100),
    ])
    const beforeRow = rawJournalRows(harness)[0]!
    harness.clearEvents()

    const report = await postCheckConsistency(harness, true)
    const afterRow = rawJournalRows(harness)[0]!

    expect(report.repair_requested).toBe(true)
    expect(report.repaired).toBe(1)
    expect(afterRow[journalHeaders.indexOf('結清狀態')]).toBe('已結')
    expect(rowBytesWithoutStatus(afterRow)).toBe(rowBytesWithoutStatus(beforeRow))
    expect(report.rules.stale_status_cells.offenses).toContainEqual(
      expect.objectContaining({
        row: 2,
        expected: '已結',
        repaired: true,
      }),
    )
    expect(harness.events).toEqual([
      'lock-acquired',
      'status-written',
      'lock-released',
    ])
  })

  it('leaves the entire journal unchanged and takes no lock when repair is not opted in', async () => {
    appendJournalRows(harness, [
      receivable('audit-only', 100),
      settlement('audit-only-settlement', 'audit-only', 100),
    ])
    const before = journalBytes(harness)
    harness.clearEvents()

    const report = await postCheckConsistency(harness)

    expect(report.repair_requested).toBe(false)
    expect(report.repaired).toBe(0)
    expect(journalBytes(harness)).toBe(before)
    expect(harness.events).toEqual([])
  })

  it('returns an explicitly clean report with every rule present', async () => {
    appendJournalRows(harness, [cleanExpense('clean-book')])

    const report = await postCheckConsistency(harness)

    expect(report).toMatchObject({
      ok: true,
      clean: true,
      repair_requested: false,
      repaired: 0,
    })
    expect(Object.keys(report.rules)).toEqual(ruleNames)
    for (const ruleName of ruleNames) {
      expect(report.rules[ruleName]).toEqual({
        clean: true,
        offenses: [],
      })
    }
  })

  it.each(['weeklyConsistencyCheck', 'weeklyBackup'])(
    'does not route the editor-only %s entry point through doPost',
    async action => {
      const response = await post(harness, { action })

      expect(response).toEqual({
        ok: false,
        error: `unsupported action: ${action}`,
      })
    },
  )
})

describe('weekly operations', () => {
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

  it('prunes fifteen copies to the twelve most recent without touching outside files', () => {
    const folder = harness.drive.createFolder('weekly backups')
    const backupPrefix = 'Solo Ledger backup '
    const copies: FakeDriveFile[] = []
    for (let day = 1; day <= 15; day += 1) {
      copies.push(
        harness.drive.createFile(
          `${backupPrefix}${String(day).padStart(2, '0')}`,
          new Date(`2026-07-${String(day).padStart(2, '0')}T00:00:00.000Z`),
          folder,
        ),
      )
    }
    const outside = harness.drive.createFile(
      'outside-the-backup-folder',
      new Date('2026-01-01T00:00:00.000Z'),
    )
    const unrelatedInside = harness.drive.createFile(
      'unrelated-file-inside-backup-folder',
      new Date('2025-01-01T00:00:00.000Z'),
      folder,
    )
    const liveSpreadsheet = harness.drive.getFileById(
      'test-ledger-spreadsheet-id',
    )
    folder.addFile(liveSpreadsheet)

    harness.pruneBackups_(
      folder,
      backupPrefix,
      'test-ledger-spreadsheet-id',
    )

    expect(
      folder
        .allFiles()
        .filter(file => !file.isTrashed())
        .filter(file => file.getName().startsWith(backupPrefix))
        .map(file => file.getName()),
    ).toEqual(
      Array.from(
        { length: 12 },
        (_unused, index) =>
          `${backupPrefix}${String(index + 4).padStart(2, '0')}`,
      ),
    )
    expect(
      copies
        .filter(file => file.isTrashed())
        .map(file => file.getName()),
    ).toEqual([
      `${backupPrefix}01`,
      `${backupPrefix}02`,
      `${backupPrefix}03`,
    ])
    expect(outside.isTrashed()).toBe(false)
    expect(unrelatedInside.isTrashed()).toBe(false)
    expect(liveSpreadsheet.isTrashed()).toBe(false)
  })

  it('sends no consistency email for a clean book', () => {
    appendJournalRows(harness, [cleanExpense('clean-trigger-book')])

    const report = harness.weeklyConsistencyCheck()

    expect(report.clean).toBe(true)
    expect(harness.mailMessages).toEqual([])
  })

  it('emails the effective user only when the consistency audit fails', () => {
    appendJournalRows(harness, [
      cleanExpense('bad-trigger-book', { 金額: 0 }),
    ])

    const report = harness.weeklyConsistencyCheck()

    expect(report.clean).toBe(false)
    expect(harness.mailMessages).toEqual([
      expect.objectContaining({
        to: 'ledger-owner@example.com',
        subject: expect.stringContaining('consistency'),
        body: expect.stringContaining('non_positive_amount'),
      }),
    ])
  })

  it('copies a timestamped backup into the configured folder and then keeps twelve', () => {
    const folder = harness.drive.createFolder('configured backups')
    harness.setScriptProperty('LEDGER_BACKUP_FOLDER_ID', folder.getId())
    for (let day = 1; day <= 12; day += 1) {
      harness.drive.createFile(
        `Solo Ledger backup old-${day}`,
        new Date(`2026-06-${String(day).padStart(2, '0')}T00:00:00.000Z`),
        folder,
      )
    }

    const result = harness.weeklyBackup()
    const active = folder
      .allFiles()
      .filter(file => !file.isTrashed())

    expect(result).toMatchObject({
      ok: true,
      pruned: ['Solo Ledger backup old-1'],
    })
    expect(active).toHaveLength(12)
    expect(active.map(file => file.getName())).toContainEqual(
      expect.stringMatching(/^Solo Ledger backup /),
    )
  })

  it('installs exactly one weekly trigger for each editor-only handler', () => {
    harness.installWeeklyTriggers()
    harness.installWeeklyTriggers()

    expect(harness.triggers).toHaveLength(2)
    expect(harness.triggers.map(trigger => trigger.handler).sort()).toEqual([
      'weeklyBackup',
      'weeklyConsistencyCheck',
    ])
    for (const trigger of harness.triggers) {
      expect(trigger.weekDay).toBe('MONDAY')
      expect(trigger.hour).toBeGreaterThanOrEqual(0)
    }
  })
})

const handlerEnv: Env = {
  EXPENSE_API_URL: 'https://script.example/exec',
  EXPENSE_API_SECRET: secret,
  CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
  CF_ACCESS_AUD: 'aud-tag',
}
const handlerNow = 1_700_000_000
let handlerJwks: JWTVerifyGetKey
let handlerCookie: string

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  const jwk = await exportJWK(pair.publicKey)
  handlerJwks = createLocalJWKSet({
    keys: [{ ...jwk, alg: 'RS256', kid: 'consistency-key' }],
  })
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'consistency-key' })
    .setAudience(handlerEnv.CF_ACCESS_AUD)
    .setExpirationTime(handlerNow + 86_400)
    .setIssuedAt(handlerNow)
    .sign(pair.privateKey as CryptoKey)
  handlerCookie = `CF_Authorization=${token}`
})

describe('check_consistency Pages handler', () => {
  it('allows and forwards the explicit repair flag under a random nonce', async () => {
    const upstreamBody = '{"ok":true,"clean":false,"repaired":1}'
    const fetchFn = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        const envelope = JSON.parse(String(init?.body)) as {
          nonce: string
          payload: string
        }
        expect(envelope.nonce).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        )
        expect(decodePayload(envelope.payload)).toEqual({
          action: 'check_consistency',
          repair: true,
        })
        return new Response(upstreamBody, { status: 200 })
      },
    ) as unknown as typeof fetch

    const response = await handleAction(
      'check_consistency',
      handlerRequest({ repair: true }),
      handlerEnv,
      {
        jwks: handlerJwks,
        fetchFn,
        now: () => handlerNow,
      },
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe(upstreamBody)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('rejects a non-boolean repair flag before contacting Apps Script', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('must not fetch')
    }) as unknown as typeof fetch

    const response = await handleAction(
      'check_consistency',
      handlerRequest({ repair: 'yes' }),
      handlerEnv,
      {
        jwks: handlerJwks,
        fetchFn,
        now: () => handlerNow,
      },
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      ok: false,
      error: 'invalid repair flag',
    })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON before contacting Apps Script', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('must not fetch')
    }) as unknown as typeof fetch

    const response = await handleAction(
      'check_consistency',
      handlerRawRequest('{repair'),
      handlerEnv,
      {
        jwks: handlerJwks,
        fetchFn,
        now: () => handlerNow,
      },
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      ok: false,
      error: 'invalid request body',
    })
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

function cleanExpense(
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

function receivable(
  txnId: string,
  amount: number,
  overrides: JournalRow = {},
): JournalRow {
  return cleanExpense(txnId, {
    借方帳戶: '應收帳款',
    金額: amount,
    分類: '',
    交易對象: '阿明',
    說明: '代墊',
    結清狀態: '未結',
    ...overrides,
  })
}

function transfer(txnId: string): JournalRow {
  return cleanExpense(txnId, {
    類型: '轉帳',
    借方帳戶: '銀行',
    貸方帳戶: '現金',
    分類: '',
    交易對象: '',
    說明: '存款',
  })
}

function settlement(
  txnId: string,
  originalTxnId: string,
  amount: number,
  currency = 'TWD',
): JournalRow {
  return {
    ...transfer(txnId),
    日期: '2026-07-27',
    時間: '',
    借方帳戶: '銀行',
    貸方帳戶: '應收帳款',
    金額: amount,
    幣別: currency,
    說明: '',
    沖銷txn_id: originalTxnId,
  }
}

function reversal(
  txnId: string,
  originalTxnId: string,
  currency: string,
): JournalRow {
  return cleanExpense(txnId, {
    日期: '2026-07-27',
    時間: '',
    類型: '沖銷',
    借方帳戶: '現金',
    貸方帳戶: '餐飲',
    幣別: currency,
    交易對象: '',
    說明: '',
    沖銷txn_id: originalTxnId,
  })
}

async function postCheckConsistency(
  harness: FakeGasHarness,
  repair = false,
): Promise<ConsistencyReport> {
  return await post(harness, {
    action: 'check_consistency',
    repair,
  }) as unknown as ConsistencyReport
}

async function post(
  harness: FakeGasHarness,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const envelope = await buildEnvelope(
    secret,
    payload,
    Math.floor(fixedNow.getTime() / 1000),
    `consistency-${crypto.randomUUID()}`,
  )
  return parseOutput(
    harness.doPost({ postData: { contents: JSON.stringify(envelope) } }),
  )
}

function parseOutput(output: FakeTextOutput): Record<string, unknown> {
  expect(output.getMimeType()).toBe('application/json')
  return JSON.parse(output.getContent()) as Record<string, unknown>
}

function requiredSheet(harness: FakeGasHarness, name: string): FakeSheet {
  const sheet = harness.spreadsheet.getSheetByName(name)
  if (!sheet) throw new Error(`missing test sheet: ${name}`)
  return sheet
}

function appendJournalRows(
  harness: FakeGasHarness,
  rows: JournalRow[],
): void {
  const journal = requiredSheet(harness, '日記帳')
  const values = rows.map(row =>
    journalHeaders.map(header => row[header] ?? ''),
  )
  journal
    .getRange(
      journal.getLastRow() + 1,
      1,
      values.length,
      journalHeaders.length,
    )
    .setValues(values)
}

function rawJournalRows(harness: FakeGasHarness): unknown[][] {
  const journal = requiredSheet(harness, '日記帳')
  if (journal.getLastRow() < 2) return []
  return journal
    .getRange(
      2,
      1,
      journal.getLastRow() - 1,
      journal.getLastColumn(),
    )
    .getValues()
}

function journalBytes(harness: FakeGasHarness): string {
  const journal = requiredSheet(harness, '日記帳')
  return JSON.stringify(
    journal
      .getRange(1, 1, journal.getLastRow(), journal.getLastColumn())
      .getValues(),
  )
}

function rowBytesWithoutStatus(row: unknown[]): string {
  const statusIndex = journalHeaders.indexOf('結清狀態')
  return JSON.stringify(
    row.map((value, index) =>
      index === statusIndex ? '__STATUS_CELL__' : value,
    ),
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
  const row = values.findIndex(
    valuesRow => valuesRow[nameColumn] === accountName,
  )
  if (row < 1) throw new Error(`missing test account: ${accountName}`)
  accounts.getRange(row + 1, enabledColumn + 1).setValues([[enabled]])
}

function handlerRequest(body: unknown): Request {
  return handlerRawRequest(JSON.stringify(body))
}

function handlerRawRequest(body: string): Request {
  return new Request('https://pwa.example/api/check_consistency', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: handlerCookie,
    },
    body,
  })
}

function decodePayload(encoded: string): unknown {
  const base64 = encoded
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(encoded.length / 4) * 4, '=')
  const bytes = Uint8Array.from(
    atob(base64),
    character => character.charCodeAt(0),
  )
  return JSON.parse(new TextDecoder().decode(bytes))
}
