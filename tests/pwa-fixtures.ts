export const CACHED_OPTIONS = {
  schema_version: 'schema-old',
  accounts: [
    { name: '錢包', type: '資產', subtype: '現金', sort: 10 },
    { name: '台新銀行', type: '資產', subtype: '銀行', sort: 20 },
    { name: '國泰卡', type: '負債', subtype: '信用卡', sort: 30 },
  ],
  categories: {
    支出: ['餐飲', '交通'],
    收入: ['薪資', '利息'],
  },
  payees: ['全聯', '小明'],
  defaults: {
    currency: 'TWD',
    account: '錢包',
  },
} as const

export const REFRESHED_OPTIONS = {
  schema_version: 'schema-new',
  accounts: [
    ...CACHED_OPTIONS.accounts,
    { name: '悠遊卡', type: '資產', subtype: '電子票證', sort: 40 },
  ],
  categories: {
    支出: [...CACHED_OPTIONS.categories.支出, '醫療'],
    收入: [...CACHED_OPTIONS.categories.收入],
  },
  payees: [...CACHED_OPTIONS.payees, '家樂福'],
  defaults: {
    currency: 'TWD',
    account: '台新銀行',
  },
} as const

export const RECENT_TRANSACTIONS = [
  {
    txn_id: 'txn-recent',
    日期: '2026-07-27',
    時間: '18:30',
    類型: '支出',
    借方帳戶: '餐飲',
    貸方帳戶: '錢包',
    金額: '260.00',
    幣別: 'TWD',
    分類: '餐飲',
    對象: '全聯',
    說明: '晚餐',
    結清狀態: '未結',
  },
  {
    txn_id: '',
    日期: '2026-07-26',
    時間: '',
    類型: '收入',
    借方帳戶: '錢包',
    貸方帳戶: '薪資',
    金額: '50000',
    幣別: 'TWD',
    分類: '薪資',
    對象: '',
    說明: '手動補登',
    結清狀態: '',
  },
] as const

export const RECEIVABLE_GROUPS = [
  {
    對象: '阿明',
    entries: [
      {
        txn_id: 'receivable-open-001',
        日期: '2026-07-26',
        金額: 500,
        幣別: 'TWD',
        對象: '阿明',
        說明: '代買車票',
        結清狀態: '部分',
        direction: '應收',
        outstanding: 320,
        view_only: false,
      },
      {
        txn_id: '',
        日期: '2026-07-25',
        金額: 80,
        幣別: 'TWD',
        對象: '阿明',
        說明: '手動代墊',
        結清狀態: '未結',
        direction: '應收',
        outstanding: 80,
        view_only: true,
      },
    ],
  },
  {
    對象: '小美',
    entries: [
      {
        txn_id: 'payable-open-001',
        日期: '2026-07-24',
        金額: 720,
        幣別: 'TWD',
        對象: '小美',
        說明: '朋友先付晚餐',
        結清狀態: '未結',
        direction: '應付',
        outstanding: 720,
        view_only: false,
      },
    ],
  },
] as const

export const PARTIALLY_SETTLED_GROUPS = [
  {
    ...RECEIVABLE_GROUPS[0],
    entries: [
      {
        ...RECEIVABLE_GROUPS[0].entries[0],
        outstanding: 120,
        結清狀態: '部分',
      },
      RECEIVABLE_GROUPS[0].entries[1],
    ],
  },
  RECEIVABLE_GROUPS[1],
] as const
