export type TransactionType = '支出' | '收入' | '轉帳'

export type Transaction = {
  type: TransactionType
  amount: number
  date: string
  description: string
  time?: string
  account?: string
  toAccount?: string
  category?: string
  payee?: string
  currency?: string
  iou?: '應收' | '應付'
}

export type FormState = {
  type: TransactionType
  amountText: string
  currency: string
  date: string
  account: string | null
  toAccount: string | null
  category: string | null
  payee: string
  iou: '應收' | '應付' | null
  description: string
  status: 'idle' | 'submitting' | 'success' | 'error'
  errorMessage: string | null
  idempotencyKey: string | null
}

export function initialState(date: string): FormState {
  return {
    type: '支出',
    amountText: '',
    currency: 'TWD',
    date,
    account: null,
    toAccount: null,
    category: null,
    payee: '',
    iou: null,
    description: '',
    status: 'idle',
    errorMessage: null,
    idempotencyKey: null,
  }
}

function edited(state: FormState, changes: Partial<FormState>): FormState {
  return {
    ...state,
    ...changes,
    status: 'idle',
    errorMessage: null,
    idempotencyKey: null,
  }
}

export function setType(state: FormState, type: TransactionType): FormState {
  if (state.type === type) return state
  if (type === '轉帳') {
    return edited(state, {
      type,
      category: null,
      payee: '',
      iou: null,
    })
  }
  return edited(state, {
    type,
    toAccount: null,
    iou: null,
  })
}

export function pressKey(state: FormState, key: string): FormState {
  let amountText = state.amountText
  if (key === '⌫') {
    amountText = amountText.slice(0, -1)
  } else if (key === '.') {
    if (amountText.includes('.')) return state
    amountText = amountText === '' ? '0.' : `${amountText}.`
  } else if (/^\d$/.test(key)) {
    const decimals = amountText.includes('.')
      ? amountText.length - amountText.indexOf('.') - 1
      : -1
    if (decimals >= 2 || amountText.replace('.', '').length >= 10) return state
    amountText = amountText === '0' ? key : `${amountText}${key}`
  } else {
    return state
  }
  return edited(state, { amountText })
}

export const selectAccount = (state: FormState, account: string): FormState =>
  edited(state, { account })

export const selectToAccount = (state: FormState, toAccount: string): FormState =>
  edited(state, { toAccount })

export const selectCategory = (state: FormState, category: string): FormState =>
  edited(state, { category })

export const setPayee = (state: FormState, payee: string): FormState =>
  edited(state, { payee })

export function setIou(
  state: FormState,
  iou: '應收' | '應付',
): FormState {
  if (state.type !== '支出') return state

  const selected = state.iou === iou ? null : iou
  return edited(state, {
    iou: selected,
    ...(selected === '應收' ? { category: null } : {}),
  })
}

export const setDescription = (state: FormState, description: string): FormState =>
  edited(state, { description })

export const setDate = (state: FormState, date: string): FormState =>
  edited(state, { date })

export function applyOptionsDefaults(
  state: FormState,
  defaults: { currency: string; account: string },
): FormState {
  return {
    ...state,
    currency: defaults.currency || state.currency,
    account: state.account ?? (defaults.account || null),
  }
}

export function amountValue(state: FormState): number {
  const amount = Number(state.amountText)
  return Number.isFinite(amount) ? amount : 0
}

export function canSubmit(state: FormState): boolean {
  if (
    state.status === 'submitting'
    || amountValue(state) <= 0
    || !/^\d{4}-\d{2}-\d{2}$/.test(state.date)
    || state.account === null
    || state.description.trim() === ''
  ) {
    return false
  }
  if (state.iou !== null && state.payee.trim() === '') return false
  if (state.type === '轉帳') return state.toAccount !== null
  if (state.type === '支出' && state.iou === '應收') return true
  return state.category !== null
}

export function buildTransaction(state: FormState): Transaction {
  const transaction: Transaction = {
    type: state.type,
    amount: amountValue(state),
    date: state.date,
    description: state.description.trim(),
    account: state.account ?? undefined,
    currency: state.currency,
  }

  if (state.type === '轉帳') {
    transaction.toAccount = state.toAccount ?? undefined
  } else {
    if (!(state.type === '支出' && state.iou === '應收')) {
      transaction.category = state.category ?? undefined
    }
    const payee = state.payee.trim()
    if (payee) transaction.payee = payee
    if (state.type === '支出' && state.iou !== null) {
      transaction.iou = state.iou
    }
  }
  return transaction
}

export function beginSubmit(
  state: FormState,
  newUuid: () => string,
): FormState {
  return {
    ...state,
    status: 'submitting',
    errorMessage: null,
    idempotencyKey: state.idempotencyKey ?? newUuid(),
  }
}

export const submitSucceeded = (state: FormState): FormState => ({
  ...state,
  status: 'success',
  errorMessage: null,
})

export const submitFailed = (
  state: FormState,
  errorMessage: string,
): FormState => ({
  ...state,
  status: 'error',
  errorMessage,
})

export const resetForNext = (state: FormState, date: string): FormState => ({
  ...initialState(date),
  currency: state.currency,
})
