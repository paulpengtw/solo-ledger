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
