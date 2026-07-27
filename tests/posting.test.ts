import { describe, expect, it } from 'vitest'
import { loadGasFunctions, type PostingInput, type PostingRow } from './helpers/gas'

const { expandPosting_ } = loadGasFunctions()

const accountTypes = {
  現金: '資產',
  銀行: '資產',
  悠遊卡: '資產',
  國泰卡: '負債',
  餐飲: '支出',
  交通: '支出',
  薪資收入: '收入',
  利息收入: '收入',
  應收帳款: '資產',
  應付帳款: '負債',
  期初餘額: '權益',
}

describe('expandPosting_ posting table', () => {
  const cases: Array<{ name: string; input: PostingInput; expected: PostingRow }> = [
    {
      name: '支出 from asset',
      input: {
        kind: 'create',
        type: '支出',
        date: '2026-07-01',
        time: '08:15',
        amount: 120,
        currency: 'TWD',
        account: '現金',
        category: '餐飲',
        payee: '早餐店',
        description: '早餐',
        accountTypes,
        txnId: 'expense-asset-001',
        now: '2026-07-01T08:15:30+08:00',
      },
      expected: {
        日期: '2026-07-01',
        時間: '08:15',
        類型: '支出',
        借方帳戶: '餐飲',
        貸方帳戶: '現金',
        金額: 120,
        幣別: 'TWD',
        分類: '餐飲',
        對象: '早餐店',
        說明: '早餐',
        結清狀態: '',
        沖銷txn_id: '',
        txn_id: 'expense-asset-001',
        來源: 'pwa',
        建立時間: '2026-07-01T08:15:30+08:00',
      },
    },
    {
      name: '支出 by credit card',
      input: {
        kind: 'create',
        type: '支出',
        date: '2026-07-02',
        time: '19:40',
        amount: 880,
        currency: 'TWD',
        account: '國泰卡',
        category: '餐飲',
        payee: '餐廳',
        description: '晚餐',
        accountTypes,
        txnId: 'expense-card-001',
        now: '2026-07-02T19:41:00+08:00',
      },
      expected: {
        日期: '2026-07-02',
        時間: '19:40',
        類型: '支出',
        借方帳戶: '餐飲',
        貸方帳戶: '國泰卡',
        金額: 880,
        幣別: 'TWD',
        分類: '餐飲',
        對象: '餐廳',
        說明: '晚餐',
        結清狀態: '',
        沖銷txn_id: '',
        txn_id: 'expense-card-001',
        來源: 'pwa',
        建立時間: '2026-07-02T19:41:00+08:00',
      },
    },
    {
      name: '轉帳',
      input: {
        kind: 'create',
        type: '轉帳',
        date: '2026-07-03',
        amount: 3000,
        currency: 'TWD',
        account: '銀行',
        toAccount: '悠遊卡',
        description: '悠遊卡加值',
        accountTypes,
        txnId: 'transfer-001',
        now: '2026-07-03T10:00:00+08:00',
      },
      expected: {
        日期: '2026-07-03',
        時間: '',
        類型: '轉帳',
        借方帳戶: '悠遊卡',
        貸方帳戶: '銀行',
        金額: 3000,
        幣別: 'TWD',
        分類: '',
        對象: '',
        說明: '悠遊卡加值',
        結清狀態: '',
        沖銷txn_id: '',
        txn_id: 'transfer-001',
        來源: 'pwa',
        建立時間: '2026-07-03T10:00:00+08:00',
      },
    },
    {
      name: '收入',
      input: {
        kind: 'create',
        type: '收入',
        date: '2026-07-04',
        time: '17:30',
        amount: 65000,
        currency: 'TWD',
        account: '銀行',
        category: '薪資收入',
        payee: '公司',
        description: '七月薪資',
        accountTypes,
        txnId: 'income-001',
        now: '2026-07-04T17:31:00+08:00',
      },
      expected: {
        日期: '2026-07-04',
        時間: '17:30',
        類型: '收入',
        借方帳戶: '銀行',
        貸方帳戶: '薪資收入',
        金額: 65000,
        幣別: 'TWD',
        分類: '薪資收入',
        對象: '公司',
        說明: '七月薪資',
        結清狀態: '',
        沖銷txn_id: '',
        txn_id: 'income-001',
        來源: 'pwa',
        建立時間: '2026-07-04T17:31:00+08:00',
      },
    },
    {
      name: '代墊 (iou 應收)',
      input: {
        kind: 'create',
        type: '支出',
        date: '2026-07-05',
        amount: 450,
        currency: 'TWD',
        account: '現金',
        payee: '阿明',
        description: '代買車票',
        iou: '應收',
        accountTypes,
        txnId: 'receivable-001',
        now: '2026-07-05T11:00:00+08:00',
      },
      expected: {
        日期: '2026-07-05',
        時間: '',
        類型: '支出',
        借方帳戶: '應收帳款',
        貸方帳戶: '現金',
        金額: 450,
        幣別: 'TWD',
        分類: '',
        對象: '阿明',
        說明: '代買車票',
        結清狀態: '未結',
        沖銷txn_id: '',
        txn_id: 'receivable-001',
        來源: 'pwa',
        建立時間: '2026-07-05T11:00:00+08:00',
      },
    },
    {
      name: 'Friend paid for user (iou 應付)',
      input: {
        kind: 'create',
        type: '支出',
        date: '2026-07-06',
        time: '12:20',
        amount: 720,
        currency: 'TWD',
        account: '現金',
        category: '餐飲',
        payee: '阿明',
        description: '朋友先付聚餐',
        iou: '應付',
        accountTypes,
        txnId: 'payable-001',
        now: '2026-07-06T12:21:00+08:00',
      },
      expected: {
        日期: '2026-07-06',
        時間: '12:20',
        類型: '支出',
        借方帳戶: '餐飲',
        貸方帳戶: '應付帳款',
        金額: 720,
        幣別: 'TWD',
        分類: '餐飲',
        對象: '阿明',
        說明: '朋友先付聚餐',
        結清狀態: '未結',
        沖銷txn_id: '',
        txn_id: 'payable-001',
        來源: 'pwa',
        建立時間: '2026-07-06T12:21:00+08:00',
      },
    },
    {
      name: 'settle collects a receivable',
      input: {
        kind: 'settle',
        original: {
          借方帳戶: '應收帳款',
          貸方帳戶: '現金',
          金額: 450,
          幣別: 'TWD',
          txn_id: 'receivable-001',
        },
        account: '銀行',
        amount: 200,
        date: '2026-07-07',
        defaultCurrency: 'TWD',
        accountTypes,
        txnId: 'settle-receivable-001',
        now: '2026-07-07T09:00:00+08:00',
      },
      expected: {
        日期: '2026-07-07',
        時間: '',
        類型: '轉帳',
        借方帳戶: '銀行',
        貸方帳戶: '應收帳款',
        金額: 200,
        幣別: 'TWD',
        分類: '',
        對象: '',
        說明: '',
        結清狀態: '',
        沖銷txn_id: 'receivable-001',
        txn_id: 'settle-receivable-001',
        來源: 'pwa',
        建立時間: '2026-07-07T09:00:00+08:00',
      },
    },
    {
      name: 'settle repays a payable',
      input: {
        kind: 'settle',
        original: {
          借方帳戶: '餐飲',
          貸方帳戶: '應付帳款',
          金額: 720,
          幣別: 'TWD',
          txn_id: 'payable-001',
        },
        account: '銀行',
        amount: 300,
        date: '2026-07-08',
        defaultCurrency: 'TWD',
        accountTypes,
        txnId: 'settle-payable-001',
        now: '2026-07-08T09:30:00+08:00',
      },
      expected: {
        日期: '2026-07-08',
        時間: '',
        類型: '轉帳',
        借方帳戶: '應付帳款',
        貸方帳戶: '銀行',
        金額: 300,
        幣別: 'TWD',
        分類: '',
        對象: '',
        說明: '',
        結清狀態: '',
        沖銷txn_id: 'payable-001',
        txn_id: 'settle-payable-001',
        來源: 'pwa',
        建立時間: '2026-07-08T09:30:00+08:00',
      },
    },
    {
      name: 'opening balance for an asset',
      input: {
        kind: 'opening',
        account: '銀行',
        amount: 125000,
        date: '2026-07-09',
        currency: 'TWD',
        source: '移轉',
        accountTypes,
        txnId: 'opening-asset-001',
        now: '2026-07-09T08:00:00+08:00',
      },
      expected: {
        日期: '2026-07-09',
        時間: '',
        類型: '轉帳',
        借方帳戶: '銀行',
        貸方帳戶: '期初餘額',
        金額: 125000,
        幣別: 'TWD',
        分類: '',
        對象: '',
        說明: '',
        結清狀態: '',
        沖銷txn_id: '',
        txn_id: 'opening-asset-001',
        來源: '移轉',
        建立時間: '2026-07-09T08:00:00+08:00',
      },
    },
    {
      name: 'opening balance for a liability mirrors the asset rule',
      input: {
        kind: 'opening',
        account: '國泰卡',
        amount: 18000,
        date: '2026-07-10',
        currency: 'TWD',
        source: '移轉',
        accountTypes,
        txnId: 'opening-liability-001',
        now: '2026-07-10T08:00:00+08:00',
      },
      expected: {
        日期: '2026-07-10',
        時間: '',
        類型: '轉帳',
        借方帳戶: '期初餘額',
        貸方帳戶: '國泰卡',
        金額: 18000,
        幣別: 'TWD',
        分類: '',
        對象: '',
        說明: '',
        結清狀態: '',
        沖銷txn_id: '',
        txn_id: 'opening-liability-001',
        來源: '移轉',
        建立時間: '2026-07-10T08:00:00+08:00',
      },
    },
    {
      name: 'reverse mirrors the original posting',
      input: {
        kind: 'reverse',
        original: {
          借方帳戶: '餐飲',
          貸方帳戶: '現金',
          金額: 345,
          幣別: 'TWD',
          txn_id: 'expense-original-001',
        },
        date: '2026-07-11',
        defaultCurrency: 'TWD',
        accountTypes,
        txnId: 'reverse-001',
        now: '2026-07-11T13:00:00+08:00',
      },
      expected: {
        日期: '2026-07-11',
        時間: '',
        類型: '沖銷',
        借方帳戶: '現金',
        貸方帳戶: '餐飲',
        金額: 345,
        幣別: 'TWD',
        分類: '餐飲',
        對象: '',
        說明: '',
        結清狀態: '',
        沖銷txn_id: 'expense-original-001',
        txn_id: 'reverse-001',
        來源: 'pwa',
        建立時間: '2026-07-11T13:00:00+08:00',
      },
    },
  ]

  it.each(cases)('$name returns the full 15-column journal row', ({ input, expected }) => {
    expect(expandPosting_(input)).toEqual(expected)
  })
})

describe('expandPosting_ create field matrix', () => {
  const requiredCases: Array<{ name: string; field: string; input: PostingInput }> = [
    {
      name: '支出 requires account',
      field: 'account',
      input: {
        kind: 'create',
        type: '支出',
        date: '2026-07-20',
        amount: 100,
        currency: 'TWD',
        category: '餐飲',
        accountTypes,
        txnId: 'validation-001',
        now: '2026-07-20T10:00:00+08:00',
      },
    },
    {
      name: '支出 requires category',
      field: 'category',
      input: {
        kind: 'create',
        type: '支出',
        date: '2026-07-20',
        amount: 100,
        currency: 'TWD',
        account: '現金',
        accountTypes,
        txnId: 'validation-002',
        now: '2026-07-20T10:00:00+08:00',
      },
    },
    {
      name: '收入 requires account',
      field: 'account',
      input: {
        kind: 'create',
        type: '收入',
        date: '2026-07-20',
        amount: 100,
        currency: 'TWD',
        category: '薪資收入',
        accountTypes,
        txnId: 'validation-003',
        now: '2026-07-20T10:00:00+08:00',
      },
    },
    {
      name: '收入 requires category',
      field: 'category',
      input: {
        kind: 'create',
        type: '收入',
        date: '2026-07-20',
        amount: 100,
        currency: 'TWD',
        account: '銀行',
        accountTypes,
        txnId: 'validation-004',
        now: '2026-07-20T10:00:00+08:00',
      },
    },
    {
      name: '轉帳 requires account',
      field: 'account',
      input: {
        kind: 'create',
        type: '轉帳',
        date: '2026-07-20',
        amount: 100,
        currency: 'TWD',
        toAccount: '銀行',
        accountTypes,
        txnId: 'validation-005',
        now: '2026-07-20T10:00:00+08:00',
      },
    },
    {
      name: '轉帳 requires toAccount',
      field: 'toAccount',
      input: {
        kind: 'create',
        type: '轉帳',
        date: '2026-07-20',
        amount: 100,
        currency: 'TWD',
        account: '現金',
        accountTypes,
        txnId: 'validation-006',
        now: '2026-07-20T10:00:00+08:00',
      },
    },
    {
      name: 'iou 應收 requires payee',
      field: 'payee',
      input: {
        kind: 'create',
        type: '支出',
        date: '2026-07-20',
        amount: 100,
        currency: 'TWD',
        account: '現金',
        iou: '應收',
        accountTypes,
        txnId: 'validation-007',
        now: '2026-07-20T10:00:00+08:00',
      },
    },
    {
      name: 'iou 應付 requires payee',
      field: 'payee',
      input: {
        kind: 'create',
        type: '支出',
        date: '2026-07-20',
        amount: 100,
        currency: 'TWD',
        account: '現金',
        category: '餐飲',
        iou: '應付',
        accountTypes,
        txnId: 'validation-008',
        now: '2026-07-20T10:00:00+08:00',
      },
    },
  ]

  const rejectedCases: Array<{ name: string; field: string; input: PostingInput }> = [
    {
      name: '支出 rejects toAccount',
      field: 'toAccount',
      input: {
        kind: 'create',
        type: '支出',
        date: '2026-07-20',
        amount: 100,
        currency: 'TWD',
        account: '現金',
        toAccount: '銀行',
        category: '餐飲',
        accountTypes,
        txnId: 'validation-009',
        now: '2026-07-20T10:00:00+08:00',
      },
    },
    {
      name: '收入 rejects toAccount',
      field: 'toAccount',
      input: {
        kind: 'create',
        type: '收入',
        date: '2026-07-20',
        amount: 100,
        currency: 'TWD',
        account: '銀行',
        toAccount: '現金',
        category: '薪資收入',
        accountTypes,
        txnId: 'validation-010',
        now: '2026-07-20T10:00:00+08:00',
      },
    },
    {
      name: '收入 rejects iou',
      field: 'iou',
      input: {
        kind: 'create',
        type: '收入',
        date: '2026-07-20',
        amount: 100,
        currency: 'TWD',
        account: '銀行',
        category: '薪資收入',
        iou: '應收',
        accountTypes,
        txnId: 'validation-011',
        now: '2026-07-20T10:00:00+08:00',
      },
    },
    {
      name: '轉帳 rejects category',
      field: 'category',
      input: {
        kind: 'create',
        type: '轉帳',
        date: '2026-07-20',
        amount: 100,
        currency: 'TWD',
        account: '現金',
        toAccount: '銀行',
        category: '餐飲',
        accountTypes,
        txnId: 'validation-012',
        now: '2026-07-20T10:00:00+08:00',
      },
    },
    {
      name: '轉帳 rejects payee',
      field: 'payee',
      input: {
        kind: 'create',
        type: '轉帳',
        date: '2026-07-20',
        amount: 100,
        currency: 'TWD',
        account: '現金',
        toAccount: '銀行',
        payee: '阿明',
        accountTypes,
        txnId: 'validation-013',
        now: '2026-07-20T10:00:00+08:00',
      },
    },
    {
      name: '轉帳 rejects iou',
      field: 'iou',
      input: {
        kind: 'create',
        type: '轉帳',
        date: '2026-07-20',
        amount: 100,
        currency: 'TWD',
        account: '現金',
        toAccount: '銀行',
        iou: '應付',
        accountTypes,
        txnId: 'validation-014',
        now: '2026-07-20T10:00:00+08:00',
      },
    },
    {
      name: 'iou 應收 rejects category',
      field: 'category',
      input: {
        kind: 'create',
        type: '支出',
        date: '2026-07-20',
        amount: 100,
        currency: 'TWD',
        account: '現金',
        category: '餐飲',
        payee: '阿明',
        iou: '應收',
        accountTypes,
        txnId: 'validation-015',
        now: '2026-07-20T10:00:00+08:00',
      },
    },
  ]

  const rejectedFieldsWithValidInputs: Array<{
    name: string
    field: string
    input: PostingInput
  }> = [
    {
      name: '支出 toAccount',
      field: 'toAccount',
      input: {
        kind: 'create',
        type: '支出',
        date: '2026-07-20',
        amount: 100,
        currency: 'TWD',
        account: '現金',
        category: '餐飲',
        accountTypes,
        txnId: 'blank-validation-001',
        now: '2026-07-20T10:00:00+08:00',
      },
    },
    {
      name: '收入 toAccount',
      field: 'toAccount',
      input: {
        kind: 'create',
        type: '收入',
        date: '2026-07-20',
        amount: 100,
        currency: 'TWD',
        account: '銀行',
        category: '薪資收入',
        accountTypes,
        txnId: 'blank-validation-002',
        now: '2026-07-20T10:00:00+08:00',
      },
    },
    {
      name: '轉帳 category',
      field: 'category',
      input: {
        kind: 'create',
        type: '轉帳',
        date: '2026-07-20',
        amount: 100,
        currency: 'TWD',
        account: '現金',
        toAccount: '銀行',
        accountTypes,
        txnId: 'blank-validation-003',
        now: '2026-07-20T10:00:00+08:00',
      },
    },
    {
      name: '轉帳 payee',
      field: 'payee',
      input: {
        kind: 'create',
        type: '轉帳',
        date: '2026-07-20',
        amount: 100,
        currency: 'TWD',
        account: '現金',
        toAccount: '銀行',
        accountTypes,
        txnId: 'blank-validation-004',
        now: '2026-07-20T10:00:00+08:00',
      },
    },
    {
      name: '收入 iou',
      field: 'iou',
      input: {
        kind: 'create',
        type: '收入',
        date: '2026-07-20',
        amount: 100,
        currency: 'TWD',
        account: '銀行',
        category: '薪資收入',
        accountTypes,
        txnId: 'blank-validation-005',
        now: '2026-07-20T10:00:00+08:00',
      },
    },
    {
      name: '轉帳 iou',
      field: 'iou',
      input: {
        kind: 'create',
        type: '轉帳',
        date: '2026-07-20',
        amount: 100,
        currency: 'TWD',
        account: '現金',
        toAccount: '銀行',
        accountTypes,
        txnId: 'blank-validation-006',
        now: '2026-07-20T10:00:00+08:00',
      },
    },
    {
      name: 'iou 應收 category',
      field: 'category',
      input: {
        kind: 'create',
        type: '支出',
        date: '2026-07-20',
        amount: 100,
        currency: 'TWD',
        account: '現金',
        payee: '阿明',
        iou: '應收',
        accountTypes,
        txnId: 'blank-validation-007',
        now: '2026-07-20T10:00:00+08:00',
      },
    },
  ]

  const blankRejectedCases = rejectedFieldsWithValidInputs.flatMap(({ name, field, input }) => [
    {
      name: `${name} accepts an empty string`,
      input: { ...input, [field]: '' },
    },
    {
      name: `${name} accepts undefined`,
      input: { ...input, [field]: undefined },
    },
  ])

  it.each(requiredCases)('$name with an error naming $field', ({ field, input }) => {
    expect(() => expandPosting_(input)).toThrow(new RegExp(field))
  })

  it.each(rejectedCases)('$name with an error naming $field', ({ field, input }) => {
    expect(() => expandPosting_(input)).toThrow(new RegExp(field))
  })

  it.each(blankRejectedCases)('$name', ({ input }) => {
    expect(() => expandPosting_(input)).not.toThrow()
  })
})

describe('expandPosting_ linked-row currency', () => {
  const defaultCurrencyCases: Array<{ name: string; input: PostingInput }> = [
    {
      name: 'settlement',
      input: {
        kind: 'settle',
        original: {
          借方帳戶: '應收帳款',
          貸方帳戶: '現金',
          金額: 450,
          幣別: 'USD',
          txn_id: 'currency-receivable-original',
        },
        account: '銀行',
        amount: 200,
        date: '2026-07-20',
        defaultCurrency: 'TWD',
        accountTypes,
        txnId: 'currency-settlement',
        now: '2026-07-20T10:00:00+08:00',
      },
    },
    {
      name: 'reversal',
      input: {
        kind: 'reverse',
        original: {
          借方帳戶: '餐飲',
          貸方帳戶: '現金',
          金額: 345,
          幣別: 'USD',
          txn_id: 'currency-reversal-original',
        },
        date: '2026-07-20',
        defaultCurrency: 'TWD',
        accountTypes,
        txnId: 'currency-reversal',
        now: '2026-07-20T10:00:00+08:00',
      },
    },
  ]

  const requiredDefaultCurrencyCases: Array<{ name: string; input: PostingInput }> = [
    {
      name: 'settlement with defaultCurrency missing',
      input: {
        kind: 'settle',
        original: {
          借方帳戶: '應收帳款',
          貸方帳戶: '現金',
          金額: 450,
          幣別: 'TWD',
          txn_id: 'required-receivable-original-missing',
        },
        account: '銀行',
        amount: 200,
        date: '2026-07-20',
        accountTypes,
        txnId: 'required-settlement-missing',
        now: '2026-07-20T10:00:00+08:00',
      },
    },
    {
      name: 'settlement with defaultCurrency blank',
      input: {
        kind: 'settle',
        original: {
          借方帳戶: '應收帳款',
          貸方帳戶: '現金',
          金額: 450,
          幣別: 'TWD',
          txn_id: 'required-receivable-original-blank',
        },
        account: '銀行',
        amount: 200,
        date: '2026-07-20',
        defaultCurrency: '',
        accountTypes,
        txnId: 'required-settlement-blank',
        now: '2026-07-20T10:00:00+08:00',
      },
    },
    {
      name: 'reversal with defaultCurrency missing',
      input: {
        kind: 'reverse',
        original: {
          借方帳戶: '餐飲',
          貸方帳戶: '現金',
          金額: 345,
          幣別: 'TWD',
          txn_id: 'required-reversal-original-missing',
        },
        date: '2026-07-20',
        accountTypes,
        txnId: 'required-reversal-missing',
        now: '2026-07-20T10:00:00+08:00',
      },
    },
    {
      name: 'reversal with defaultCurrency blank',
      input: {
        kind: 'reverse',
        original: {
          借方帳戶: '餐飲',
          貸方帳戶: '現金',
          金額: 345,
          幣別: 'TWD',
          txn_id: 'required-reversal-original-blank',
        },
        date: '2026-07-20',
        defaultCurrency: '',
        accountTypes,
        txnId: 'required-reversal-blank',
        now: '2026-07-20T10:00:00+08:00',
      },
    },
  ]

  it.each(defaultCurrencyCases)('$name stamps the default currency, not the original currency', ({ input }) => {
    const row = expandPosting_(input)

    expect(row.幣別).toBe('TWD')
    expect(row.幣別).not.toBe('USD')
  })

  it.each(requiredDefaultCurrencyCases)('$name throws the named required-field error', ({ input }) => {
    expect(() => expandPosting_(input)).toThrowError(/^defaultCurrency is required$/)
  })
})

describe('expandPosting_ double-entry properties', () => {
  function deterministicAmounts(): () => number {
    let state = 0x5eed1234
    const amounts = [1, 2.5, 99, 1234.56, 999999]

    return () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return amounts[state % amounts.length]!
    }
  }

  const nextAmount = deterministicAmounts()
  const realAccounts = ['現金', '銀行', '悠遊卡', '國泰卡']
  const expenseCategories = ['餐飲', '交通']
  const incomeCategories = ['薪資收入', '利息收入']

  const generators: Array<(amount: number, index: number) => { input: PostingInput; expectedAmount: number }> = [
    (amount, index) => ({
      input: {
        kind: 'create',
        type: '支出',
        date: '2026-07-21',
        amount,
        currency: 'TWD',
        account: realAccounts[index % realAccounts.length],
        category: expenseCategories[index % expenseCategories.length],
        accountTypes,
        txnId: `property-expense-${index}`,
        now: '2026-07-21T10:00:00+08:00',
      },
      expectedAmount: amount,
    }),
    (amount, index) => ({
      input: {
        kind: 'create',
        type: '收入',
        date: '2026-07-21',
        amount,
        currency: 'TWD',
        account: realAccounts[index % realAccounts.length],
        category: incomeCategories[index % incomeCategories.length],
        accountTypes,
        txnId: `property-income-${index}`,
        now: '2026-07-21T10:00:00+08:00',
      },
      expectedAmount: amount,
    }),
    (amount, index) => ({
      input: {
        kind: 'create',
        type: '轉帳',
        date: '2026-07-21',
        amount,
        currency: 'TWD',
        account: realAccounts[index % realAccounts.length],
        toAccount: realAccounts[(index + 1) % realAccounts.length],
        accountTypes,
        txnId: `property-transfer-${index}`,
        now: '2026-07-21T10:00:00+08:00',
      },
      expectedAmount: amount,
    }),
    (amount, index) => ({
      input: {
        kind: 'create',
        type: '支出',
        date: '2026-07-21',
        amount,
        currency: 'TWD',
        account: realAccounts[index % realAccounts.length],
        payee: '阿明',
        iou: '應收',
        accountTypes,
        txnId: `property-receivable-${index}`,
        now: '2026-07-21T10:00:00+08:00',
      },
      expectedAmount: amount,
    }),
    (amount, index) => ({
      input: {
        kind: 'create',
        type: '支出',
        date: '2026-07-21',
        amount,
        currency: 'TWD',
        account: realAccounts[index % realAccounts.length],
        category: expenseCategories[index % expenseCategories.length],
        payee: '阿明',
        iou: '應付',
        accountTypes,
        txnId: `property-payable-${index}`,
        now: '2026-07-21T10:00:00+08:00',
      },
      expectedAmount: amount,
    }),
    (amount, index) => ({
      input: {
        kind: 'settle',
        original: {
          借方帳戶: '應收帳款',
          貸方帳戶: '現金',
          金額: amount + 1,
          幣別: 'TWD',
          txn_id: `property-receivable-original-${index}`,
        },
        account: realAccounts[index % realAccounts.length],
        amount,
        date: '2026-07-21',
        defaultCurrency: 'TWD',
        accountTypes,
        txnId: `property-settle-receivable-${index}`,
        now: '2026-07-21T10:00:00+08:00',
      },
      expectedAmount: amount,
    }),
    (amount, index) => ({
      input: {
        kind: 'settle',
        original: {
          借方帳戶: '餐飲',
          貸方帳戶: '應付帳款',
          金額: amount + 1,
          幣別: 'TWD',
          txn_id: `property-payable-original-${index}`,
        },
        account: realAccounts[index % realAccounts.length],
        amount,
        date: '2026-07-21',
        defaultCurrency: 'TWD',
        accountTypes,
        txnId: `property-settle-payable-${index}`,
        now: '2026-07-21T10:00:00+08:00',
      },
      expectedAmount: amount,
    }),
    (amount, index) => ({
      input: {
        kind: 'opening',
        account: realAccounts[index % 3],
        amount,
        date: '2026-07-21',
        currency: 'TWD',
        source: '移轉',
        accountTypes,
        txnId: `property-opening-asset-${index}`,
        now: '2026-07-21T10:00:00+08:00',
      },
      expectedAmount: amount,
    }),
    (amount, index) => ({
      input: {
        kind: 'opening',
        account: '國泰卡',
        amount,
        date: '2026-07-21',
        currency: 'TWD',
        source: '移轉',
        accountTypes,
        txnId: `property-opening-liability-${index}`,
        now: '2026-07-21T10:00:00+08:00',
      },
      expectedAmount: amount,
    }),
    (amount, index) => ({
      input: {
        kind: 'reverse',
        original: {
          借方帳戶: expenseCategories[index % expenseCategories.length],
          貸方帳戶: realAccounts[index % realAccounts.length],
          金額: amount,
          幣別: 'TWD',
          txn_id: `property-reverse-original-${index}`,
        },
        date: '2026-07-21',
        defaultCurrency: 'TWD',
        accountTypes,
        txnId: `property-reverse-${index}`,
        now: '2026-07-21T10:00:00+08:00',
      },
      expectedAmount: amount,
    }),
  ]

  it('always emits distinct non-empty accounts and the independently generated positive finite amount', () => {
    for (let round = 0; round < 10; round += 1) {
      for (let generatorIndex = 0; generatorIndex < generators.length; generatorIndex += 1) {
        const generated = generators[generatorIndex]!(nextAmount(), round * generators.length + generatorIndex)
        const row = expandPosting_(generated.input)

        expect(row.借方帳戶).not.toBe('')
        expect(row.貸方帳戶).not.toBe('')
        expect(row.借方帳戶).not.toBe(row.貸方帳戶)
        expect(row.金額).toBe(generated.expectedAmount)
        expect(Number.isFinite(row.金額)).toBe(true)
        expect(row.金額).toBeGreaterThan(0)
      }
    }
  })
})

describe('expandPosting_ purity', () => {
  it('does not touch any GAS global while expanding a posting', () => {
    expect(() =>
      expandPosting_({
        kind: 'create',
        type: '支出',
        date: '2026-07-22',
        amount: 80,
        currency: 'TWD',
        account: '現金',
        category: '餐飲',
        accountTypes,
        txnId: 'purity-001',
        now: '2026-07-22T08:00:00+08:00',
      }),
    ).not.toThrow()
  })
})
