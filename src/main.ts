import './styles.css'
import {
  authCheck,
  listReceivables,
  listTransactions,
  loadOptions,
  reverseTransaction,
  settleReceivable,
  submitTransaction,
  type AccountOption,
  type LedgerOptions,
  type LedgerTransaction,
  type ReceivableEntry,
  type ReceivableGroup,
  type Reversal,
  type Settlement,
} from './api'
import { startSessionGuard } from './auth'
import * as State from './state'

type MountDependencies = {
  today?: () => string
  randomUUID?: () => string
}

const RECENT_DATE_FROM = '0001-01-01'
const RECENT_DATE_TO = '9999-12-31'

function localDate(): string {
  const date = new Date()
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function button(
  text: string,
  dataName: string,
  dataValue: string,
  selected: boolean,
): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.textContent = text
  element.dataset[dataName] = dataValue
  element.classList.toggle('selected', selected)
  return element
}

function groupAccounts(
  accounts: AccountOption[],
  selected: string | null,
): DocumentFragment {
  const groups = new Map<string, AccountOption[]>()
  for (const account of accounts) {
    const subtype = account.subtype.trim() || '其他'
    const group = groups.get(subtype) ?? []
    group.push(account)
    groups.set(subtype, group)
  }

  const fragment = document.createDocumentFragment()
  for (const [subtype, groupedAccounts] of groups) {
    const section = document.createElement('section')
    section.className = 'option-group'
    section.dataset['subtype'] = subtype
    const heading = document.createElement('h3')
    heading.textContent = subtype
    const choices = document.createElement('div')
    choices.className = 'option-grid'
    for (const account of groupedAccounts) {
      choices.appendChild(button(
        account.name,
        'account',
        account.name,
        selected === account.name,
      ))
    }
    section.appendChild(heading)
    section.appendChild(choices)
    fragment.appendChild(section)
  }
  return fragment
}

export function mountApp(
  root: HTMLElement,
  dependencies: MountDependencies = {},
): () => void {
  const today = dependencies.today ?? localDate
  const randomUUID = dependencies.randomUUID ?? (() => crypto.randomUUID())
  let state = State.initialState(today())
  let options: LedgerOptions | null = null
  let sessionSchemaVersion: string | null = null
  let resetTimer: ReturnType<typeof setTimeout> | null = null
  let recentRequest = 0
  let recentTransactions: LedgerTransaction[] = []
  let receivablesRequest = 0
  let receivableGroups: ReceivableGroup[] = []
  let pendingSettlement: {
    entry: ReceivableEntry
    operation: {
      settlement: Settlement
      idempotencyKey: string
    } | null
    submitting: boolean
    controlsLocked: boolean
  } | null = null
  let pendingReversal: {
    transaction: LedgerTransaction
    operation: {
      reversal: Reversal
      idempotencyKey: string
    } | null
    submitting: boolean
    controlsLocked: boolean
  } | null = null
  let stopped = false

  // 說明 must stay required: speech-to-text gives every journal row a narrative.
  root.innerHTML = `
    <header class="app-header">
      <p class="eyebrow">SOLO LEDGER</p>
      <h1 id="page-title">快速記帳</h1>
    </header>
    <nav id="view-switch" class="segmented" aria-label="畫面">
      <button type="button" data-view="entry" class="selected" aria-pressed="true">記帳</button>
      <button type="button" data-view="recent" aria-pressed="false">最近紀錄</button>
      <button type="button" data-view="outstanding" aria-pressed="false">未結項目</button>
    </nav>
    <main id="entry-view">
    <div id="schema-banner" role="status" hidden>選項已更新，請確認目前選擇</div>
    <div id="type-toggle" class="segmented" aria-label="類型">
      <button type="button" data-type="支出">支出</button>
      <button type="button" data-type="收入">收入</button>
      <button type="button" data-type="轉帳">轉帳</button>
    </div>
    <section id="amount-section" aria-labelledby="amount-heading">
      <div class="section-heading">
        <h2 id="amount-heading">金額</h2>
        <span id="currency-chip">TWD</span>
      </div>
      <output id="amount-display" aria-live="polite">0</output>
      <div id="keypad" aria-label="金額鍵盤">
        <button type="button" data-key="1">1</button>
        <button type="button" data-key="2">2</button>
        <button type="button" data-key="3">3</button>
        <button type="button" data-key="4">4</button>
        <button type="button" data-key="5">5</button>
        <button type="button" data-key="6">6</button>
        <button type="button" data-key="7">7</button>
        <button type="button" data-key="8">8</button>
        <button type="button" data-key="9">9</button>
        <button type="button" data-key=".">.</button>
        <button type="button" data-key="0">0</button>
        <button type="button" data-key="⌫" aria-label="刪除一位">⌫</button>
      </div>
    </section>
    <section class="form-section" aria-labelledby="account-heading">
      <h2 id="account-heading">帳戶</h2>
      <div id="account-picker" class="grouped-picker"></div>
    </section>
    <section id="to-account-section" class="form-section" aria-labelledby="to-account-heading" hidden>
      <h2 id="to-account-heading">轉入帳戶</h2>
      <div id="to-account-picker" class="grouped-picker"></div>
    </section>
    <section id="category-section" class="form-section" aria-labelledby="category-heading">
      <h2 id="category-heading">分類</h2>
      <div id="category-grid" class="option-grid"></div>
    </section>
    <section id="payee-section" class="form-section" aria-labelledby="payee-heading">
      <h2 id="payee-heading">對象 <span id="payee-requirement">選填</span></h2>
      <div id="iou-toggle" class="segmented" style="grid-template-columns: repeat(2, 1fr)"
        aria-label="代墊或應付">
        <button type="button" data-iou="應收" aria-pressed="false">代墊(應收)</button>
        <button type="button" data-iou="應付" aria-pressed="false">應付</button>
      </div>
      <div id="payee-suggestions" class="option-grid compact"></div>
      <label class="text-field">
        <span>自訂對象</span>
        <input id="payee-input" type="text" autocomplete="off" placeholder="輸入其他對象" />
      </label>
    </section>
    <section class="form-section details">
      <label class="text-field required">
        <span>說明（必填）</span>
        <input id="description-input" type="text" required aria-required="true"
          enterkeyhint="done" placeholder="例如：晚餐，可使用語音輸入" />
      </label>
      <label class="text-field">
        <span>日期</span>
        <input id="date-input" type="date" />
      </label>
    </section>
    <p id="status-message" role="alert"></p>
    <div id="submit-bar">
      <button id="submit-btn" type="button" disabled>記帳</button>
    </div>
    </main>
    <main id="recent-view" hidden>
      <section class="recent-panel" aria-labelledby="recent-heading">
        <div class="recent-toolbar">
          <h2 id="recent-heading">最近 200 筆</h2>
          <button id="refresh-transactions" type="button">重新整理</button>
        </div>
        <p id="recent-status" role="status"></p>
        <div id="transaction-list"></div>
      </section>
    </main>
    <main id="outstanding-view" hidden>
      <section class="receivables-panel" aria-labelledby="receivables-heading">
        <div class="recent-toolbar">
          <h2 id="receivables-heading">應收與應付</h2>
          <button id="refresh-receivables" type="button">重新整理</button>
        </div>
        <p id="receivables-status" role="status"></p>
        <div id="receivables-list"></div>
      </section>
    </main>
    <aside
      id="settle-confirmation"
      class="settle-confirmation"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settle-heading"
      hidden
    >
      <div class="settle-card">
        <h2 id="settle-heading">確認結清</h2>
        <p id="settle-target"></p>
        <p class="irreversible-warning">結清後無法復原。請確認金額與帳戶正確。</p>
        <label class="text-field required">
          <span>結清金額</span>
          <input id="settle-amount" type="number" min="0.01" step="0.01" inputmode="decimal" />
        </label>
        <label class="text-field required">
          <span>收付帳戶</span>
          <select id="settle-account"></select>
        </label>
        <label class="text-field required">
          <span>日期</span>
          <input id="settle-date" type="date" />
        </label>
        <p id="settle-status" role="alert"></p>
        <div class="settle-actions">
          <button id="cancel-settle" type="button">取消</button>
          <button id="confirm-settle" type="button">確認結清</button>
        </div>
      </div>
    </aside>
    <aside
      id="reverse-confirmation"
      class="settle-confirmation"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reverse-heading"
      hidden
    >
      <div class="settle-card">
        <h2 id="reverse-heading">確認沖銷</h2>
        <p id="reverse-target"></p>
        <p class="irreversible-warning">將新增一筆相反分錄，原始紀錄不會被編輯。</p>
        <label class="text-field required">
          <span>沖銷日期</span>
          <input id="reverse-date" type="date" />
        </label>
        <p id="reverse-status" role="alert"></p>
        <div class="settle-actions">
          <button id="cancel-reverse" type="button">取消</button>
          <button id="confirm-reverse" type="button">確認沖銷</button>
        </div>
      </div>
    </aside>
  `

  const pageTitle = root.querySelector<HTMLElement>('#page-title')!
  const entryView = root.querySelector<HTMLElement>('#entry-view')!
  const recentView = root.querySelector<HTMLElement>('#recent-view')!
  const outstandingView = root.querySelector<HTMLElement>('#outstanding-view')!
  const recentStatus = root.querySelector<HTMLElement>('#recent-status')!
  const transactionList = root.querySelector<HTMLElement>('#transaction-list')!
  const refreshTransactions = root.querySelector<HTMLButtonElement>(
    '#refresh-transactions',
  )!
  const receivablesStatus = root.querySelector<HTMLElement>(
    '#receivables-status',
  )!
  const receivablesList = root.querySelector<HTMLElement>('#receivables-list')!
  const refreshReceivables = root.querySelector<HTMLButtonElement>(
    '#refresh-receivables',
  )!
  const settleConfirmation = root.querySelector<HTMLElement>(
    '#settle-confirmation',
  )!
  const settleTarget = root.querySelector<HTMLElement>('#settle-target')!
  const settleAmount = root.querySelector<HTMLInputElement>('#settle-amount')!
  const settleAccount = root.querySelector('#settle-account') as unknown as
    HTMLSelectElement
  const settleDate = root.querySelector<HTMLInputElement>('#settle-date')!
  const settleStatus = root.querySelector<HTMLElement>('#settle-status')!
  const cancelSettle = root.querySelector<HTMLButtonElement>('#cancel-settle')!
  const confirmSettle = root.querySelector<HTMLButtonElement>('#confirm-settle')!
  const reverseConfirmation = root.querySelector<HTMLElement>(
    '#reverse-confirmation',
  )!
  const reverseTarget = root.querySelector<HTMLElement>('#reverse-target')!
  const reverseDate = root.querySelector<HTMLInputElement>('#reverse-date')!
  const reverseStatus = root.querySelector<HTMLElement>('#reverse-status')!
  const cancelReverse = root.querySelector<HTMLButtonElement>('#cancel-reverse')!
  const confirmReverse = root.querySelector<HTMLButtonElement>('#confirm-reverse')!
  const schemaBanner = root.querySelector<HTMLElement>('#schema-banner')!
  const accountPicker = root.querySelector<HTMLElement>('#account-picker')!
  const toAccountPicker = root.querySelector<HTMLElement>('#to-account-picker')!
  const categoryGrid = root.querySelector<HTMLElement>('#category-grid')!
  const iouToggle = root.querySelector<HTMLElement>('#iou-toggle')!
  const payeeSuggestions = root.querySelector<HTMLElement>('#payee-suggestions')!
  const payeeRequirement = root.querySelector<HTMLElement>('#payee-requirement')!
  const payeeInput = root.querySelector<HTMLInputElement>('#payee-input')!
  const descriptionInput = root.querySelector<HTMLInputElement>('#description-input')!
  const dateInput = root.querySelector<HTMLInputElement>('#date-input')!
  const submitButton = root.querySelector<HTMLButtonElement>('#submit-btn')!

  function renderTransactions(rows: LedgerTransaction[]): void {
    transactionList.replaceChildren()
    for (const row of rows) {
      const article = document.createElement('article')
      article.className = 'transaction-row'

      const heading = document.createElement('div')
      heading.className = 'transaction-heading'
      const date = document.createElement('time')
      date.className = 'transaction-date'
      date.textContent = row.時間 ? `${row.日期} ${row.時間}` : row.日期
      const type = document.createElement('span')
      type.className = 'transaction-type'
      type.textContent = row.類型
      heading.appendChild(date)
      heading.appendChild(type)

      const body = document.createElement('div')
      body.className = 'transaction-body'
      const description = document.createElement('p')
      description.className = 'transaction-description'
      description.textContent = row.說明
      const amount = document.createElement('p')
      amount.className = 'transaction-amount'
      amount.textContent = `${row.金額} ${row.幣別}`.trim()
      body.appendChild(description)
      body.appendChild(amount)

      const accounts = document.createElement('p')
      accounts.className = 'transaction-accounts'
      accounts.textContent = `${row.借方帳戶} → ${row.貸方帳戶}`

      const details = document.createElement('div')
      details.className = 'transaction-details'
      const context = document.createElement('span')
      context.textContent = [row.分類, row.對象].filter(Boolean).join(' · ')
      const status = document.createElement('span')
      status.className = 'transaction-status'
      status.textContent = row.結清狀態
      details.appendChild(context)
      details.appendChild(status)

      article.appendChild(heading)
      article.appendChild(body)
      article.appendChild(accounts)
      article.appendChild(details)
      if (
        row.txn_id
        && (row.類型 === '支出' || row.類型 === '收入' || row.類型 === '轉帳')
        && row.結清狀態 !== '已沖銷'
      ) {
        const reverseButton = document.createElement('button')
        reverseButton.type = 'button'
        reverseButton.className = 'reverse-button'
        reverseButton.dataset['reverseTxnId'] = row.txn_id
        reverseButton.textContent = '沖銷'
        article.appendChild(reverseButton)
      }
      transactionList.appendChild(article)
    }
  }

  function renderReceivables(groups: ReceivableGroup[]): void {
    receivablesList.replaceChildren()
    for (const group of groups) {
      const section = document.createElement('section')
      section.className = 'receivable-group'
      section.dataset['counterparty'] = group.對象

      const heading = document.createElement('h3')
      heading.textContent = group.對象 || '未指定對象'
      section.appendChild(heading)

      for (const entry of group.entries) {
        const article = document.createElement('article')
        article.className = 'receivable-entry'
        article.dataset['txnId'] = entry.txn_id
        article.dataset['viewOnly'] = String(entry.view_only)

        const summary = document.createElement('div')
        summary.className = 'receivable-summary'
        const direction = document.createElement('span')
        direction.className = `receivable-direction ${entry.direction}`
        direction.textContent = entry.direction
        const description = document.createElement('span')
        description.className = 'receivable-description'
        description.textContent = entry.說明 || '未填說明'
        summary.appendChild(direction)
        summary.appendChild(description)

        const balance = document.createElement('div')
        balance.className = 'receivable-balance'
        const amount = document.createElement('strong')
        amount.textContent = `${entry.outstanding} ${entry.幣別}`.trim()
        const detail = document.createElement('span')
        detail.textContent = entry.view_only
          ? `${entry.日期} · 手動 · 僅供檢視`
          : `${entry.日期} · ${entry.結清狀態}`
        balance.appendChild(amount)
        balance.appendChild(detail)

        article.appendChild(summary)
        article.appendChild(balance)

        if (!entry.view_only) {
          const settleButton = document.createElement('button')
          settleButton.type = 'button'
          settleButton.className = 'settle-button'
          settleButton.dataset['settleTxnId'] = entry.txn_id
          settleButton.textContent = '結清'
          article.appendChild(settleButton)
        }
        section.appendChild(article)
      }
      receivablesList.appendChild(section)
    }
  }

  async function loadOutstandingReceivables(): Promise<void> {
    const request = ++receivablesRequest
    refreshReceivables.disabled = true
    receivablesStatus.textContent = '載入中…'
    receivablesList.replaceChildren()

    const groups = await listReceivables()
    if (stopped || request !== receivablesRequest) return

    refreshReceivables.disabled = false
    if (groups === null) {
      receivablesStatus.textContent = '無法載入未結項目，請再試一次'
      return
    }

    receivableGroups = groups
    receivablesStatus.textContent = groups.length === 0 ? '目前沒有未結項目' : ''
    renderReceivables(groups)
  }

  async function loadRecentTransactions(): Promise<void> {
    const request = ++recentRequest
    refreshTransactions.disabled = true
    recentStatus.textContent = '載入中…'
    transactionList.replaceChildren()

    const rows = await listTransactions(RECENT_DATE_FROM, RECENT_DATE_TO)
    if (stopped || request !== recentRequest) return

    refreshTransactions.disabled = false
    if (rows === null) {
      recentStatus.textContent = '無法載入最近紀錄，請再試一次'
      return
    }

    recentStatus.textContent = rows.length === 0 ? '目前沒有紀錄' : ''
    recentTransactions = rows
    renderTransactions(rows)
  }

  function updateReversalInteraction(): void {
    const controlsLocked = pendingReversal?.controlsLocked === true
    reverseDate.disabled = controlsLocked
    cancelReverse.disabled = controlsLocked
    confirmReverse.disabled =
      pendingReversal === null
      || pendingReversal.submitting
      || reverseDate.value === ''
  }

  function openReversal(transaction: LedgerTransaction): void {
    if (pendingReversal?.submitting) return
    pendingReversal = {
      transaction,
      operation: null,
      submitting: false,
      controlsLocked: false,
    }
    reverseTarget.textContent =
      `${transaction.類型} · ${transaction.說明 || '未填說明'} · ${transaction.金額} ${transaction.幣別}`.trim()
    reverseDate.value = today()
    reverseStatus.textContent = ''
    reverseConfirmation.hidden = false
    updateReversalInteraction()
  }

  function closeReversal(): void {
    if (pendingReversal?.submitting) return
    pendingReversal = null
    reverseConfirmation.hidden = true
    reverseStatus.textContent = ''
    updateReversalInteraction()
  }

  async function onConfirmReversal(): Promise<void> {
    if (!pendingReversal || pendingReversal.submitting) return

    const request = pendingReversal
    if (request.operation === null) {
      if (!reverseDate.value) {
        reverseStatus.textContent = '請選擇沖銷日期'
        return
      }
      request.operation = {
        reversal: {
          txn_id: request.transaction.txn_id,
          date: reverseDate.value,
        },
        idempotencyKey: randomUUID(),
      }
    }

    const operation = request.operation
    request.submitting = true
    request.controlsLocked = true
    updateReversalInteraction()
    reverseStatus.textContent = '沖銷中…'
    const result = await reverseTransaction(
      operation.reversal,
      operation.idempotencyKey,
    )
    if (stopped) return

    if (result.ok) {
      if (pendingReversal === request) {
        request.submitting = false
        closeReversal()
      }
      showFlash('沖銷完成 ✓')
      await loadRecentTransactions()
      return
    }
    if (pendingReversal === request) {
      request.submitting = false
      if (result.kind !== 'network') {
        request.operation = null
        request.controlsLocked = false
      }
      updateReversalInteraction()
      reverseStatus.textContent = result.message
      if (result.kind === 'auth') showReauthPrompt()
    }
  }

  function showView(view: 'entry' | 'recent' | 'outstanding'): void {
    const recent = view === 'recent'
    const outstanding = view === 'outstanding'
    entryView.hidden = view !== 'entry'
    recentView.hidden = !recent
    outstandingView.hidden = !outstanding
    pageTitle.textContent = recent
      ? '最近紀錄'
      : outstanding ? '未結項目' : '快速記帳'
    root.querySelectorAll<HTMLButtonElement>('#view-switch [data-view]')
      .forEach(element => {
        const selected = element.dataset['view'] === view
        element.classList.toggle('selected', selected)
        element.setAttribute('aria-pressed', String(selected))
    })
    if (recent) void loadRecentTransactions()
    if (outstanding) void loadOutstandingReceivables()
  }

  function renderSettlementAccounts(): void {
    const selected = settleAccount.value
      || options?.defaults.account
      || ''
    settleAccount.replaceChildren()
    for (const account of options?.accounts ?? []) {
      const option = document.createElement('option')
      option.value = account.name
      option.textContent = account.name
      settleAccount.appendChild(option)
    }
    if (
      selected
      && [...settleAccount.options].some(option => option.value === selected)
    ) {
      settleAccount.value = selected
    }
    updateSettlementInteraction()
  }

  function updateSettlementInteraction(): void {
    const submitting = pendingSettlement?.submitting === true
    const controlsLocked = pendingSettlement?.controlsLocked === true
    settleAmount.disabled = controlsLocked
    settleAccount.disabled = controlsLocked
    settleDate.disabled = controlsLocked
    cancelSettle.disabled = controlsLocked
    confirmSettle.disabled =
      pendingSettlement === null
      || submitting
      || (
        pendingSettlement.operation === null
        && settleAccount.value === ''
      )
  }

  function openSettlement(entry: ReceivableEntry): void {
    if (pendingSettlement?.submitting) return
    pendingSettlement = {
      entry,
      operation: null,
      submitting: false,
      controlsLocked: false,
    }
    renderSettlementAccounts()
    settleTarget.textContent = `${entry.對象 || '未指定對象'} · ${entry.direction} · ${entry.說明}`
    settleAmount.value = String(entry.outstanding)
    settleAmount.max = String(entry.outstanding)
    settleDate.value = today()
    settleStatus.textContent = ''
    settleConfirmation.hidden = false
    updateSettlementInteraction()
  }

  function closeSettlement(): void {
    if (pendingSettlement?.submitting) return
    pendingSettlement = null
    settleConfirmation.hidden = true
    settleStatus.textContent = ''
    updateSettlementInteraction()
  }

  async function onConfirmSettlement(): Promise<void> {
    if (!pendingSettlement || pendingSettlement.submitting) return

    const request = pendingSettlement
    if (request.operation === null) {
      const amount = Number(settleAmount.value)
      if (
        !Number.isFinite(amount)
        || amount <= 0
        || amount > request.entry.outstanding
      ) {
        settleStatus.textContent = '請輸入不超過未結餘額的正數'
        return
      }
      if (!settleAccount.value || !settleDate.value) {
        settleStatus.textContent = '請選擇帳戶與日期'
        return
      }
      request.operation = {
        settlement: {
          txn_id: request.entry.txn_id,
          account: settleAccount.value,
          date: settleDate.value,
          amount,
        },
        idempotencyKey: randomUUID(),
      }
    }

    const operation = request.operation
    request.submitting = true
    request.controlsLocked = true
    updateSettlementInteraction()
    settleStatus.textContent = '結清中…'
    const result = await settleReceivable(
      operation.settlement,
      operation.idempotencyKey,
    )
    if (stopped) return

    if (result.ok) {
      if (pendingSettlement === request) {
        request.submitting = false
        closeSettlement()
      }
      showFlash('結清完成 ✓')
      await loadOutstandingReceivables()
      return
    }
    if (pendingSettlement === request) {
      request.submitting = false
      if (result.kind !== 'network') {
        request.operation = null
        request.controlsLocked = false
      }
      updateSettlementInteraction()
      settleStatus.textContent = result.message
      if (result.kind === 'auth') showReauthPrompt()
    }
  }

  function renderOptions(): void {
    accountPicker.replaceChildren(
      ...(options ? [groupAccounts(options.accounts, state.account)] : []),
    )
    toAccountPicker.replaceChildren(
      ...(options ? [groupAccounts(options.accounts, state.toAccount)] : []),
    )

    categoryGrid.replaceChildren()
    if (options && state.type !== '轉帳') {
      for (const category of options.categories[state.type]) {
        categoryGrid.appendChild(button(
          category,
          'category',
          category,
          state.category === category,
        ))
      }
    }

    payeeSuggestions.replaceChildren()
    if (options && state.type !== '轉帳') {
      for (const payee of options.payees) {
        payeeSuggestions.appendChild(button(
          payee,
          'payee',
          payee,
          state.payee === payee,
        ))
      }
    }
  }

  function render(): void {
    root.querySelector<HTMLElement>('#amount-display')!.textContent =
      state.amountText || '0'
    root.querySelector<HTMLElement>('#currency-chip')!.textContent = state.currency
    root.querySelectorAll<HTMLButtonElement>('#type-toggle [data-type]').forEach(element => {
      element.classList.toggle('selected', element.dataset['type'] === state.type)
    })

    root.querySelector<HTMLElement>('#category-section')!.hidden =
      state.type === '轉帳'
      || (state.type === '支出' && state.iou === '應收')
    root.querySelector<HTMLElement>('#to-account-section')!.hidden =
      state.type !== '轉帳'
    root.querySelector<HTMLElement>('#payee-section')!.hidden =
      state.type === '轉帳'
    iouToggle.hidden = state.type !== '支出'
    iouToggle.querySelectorAll<HTMLButtonElement>('[data-iou]').forEach(element => {
      const selected = element.dataset['iou'] === state.iou
      element.classList.toggle('selected', selected)
      element.setAttribute('aria-pressed', String(selected))
    })

    const payeeRequired = state.iou !== null
    payeeRequirement.textContent = payeeRequired ? '必填' : '選填'
    payeeInput.required = payeeRequired
    payeeInput.setAttribute('aria-required', String(payeeRequired))
    payeeInput.value = state.payee
    descriptionInput.value = state.description
    dateInput.value = state.date
    submitButton.disabled = !State.canSubmit(state)
    submitButton.textContent = state.status === 'error'
      ? '再試一次'
      : state.type === '轉帳' ? '確認轉帳' : '記帳'
    root.querySelector<HTMLElement>('#status-message')!.textContent =
      state.errorMessage ?? ''
    renderOptions()
  }

  function dispatch(next: State.FormState): void {
    state = next
    render()
  }

  function applyOptions(next: LedgerOptions): void {
    if (
      sessionSchemaVersion !== null
      && next.schema_version !== sessionSchemaVersion
    ) {
      // Vocabulary drift is advisory: it never disables or blocks this form.
      schemaBanner.hidden = false
    }
    if (sessionSchemaVersion === null) {
      sessionSchemaVersion = next.schema_version
    }
    options = next
    state = State.applyOptionsDefaults(state, next.defaults)
    renderSettlementAccounts()
    render()
  }

  async function onSubmit(): Promise<void> {
    if (!State.canSubmit(state)) return
    dispatch(State.beginSubmit(state, randomUUID))
    const result = await submitTransaction(
      State.buildTransaction(state),
      state.idempotencyKey!,
    )
    if (stopped) return
    if (!result.ok) {
      dispatch(State.submitFailed(state, result.message))
      if (result.kind === 'auth') showReauthPrompt()
      return
    }

    dispatch(State.submitSucceeded(state))
    showFlash(result.alreadyRecorded ? '已記帳 ✓' : '記帳完成 ✓')
    resetTimer = setTimeout(() => {
      if (stopped) return
      state = State.resetForNext(state, today())
      if (options) state = State.applyOptionsDefaults(state, options.defaults)
      render()
    }, 600)
  }

  function showReauthPrompt(): void {
    if (document.querySelector('#reauth-prompt')) return
    const prompt = document.createElement('div')
    prompt.id = 'reauth-prompt'
    prompt.className = 'reauth-prompt'
    const message = document.createElement('span')
    message.textContent = '登入已過期'
    const reload = document.createElement('button')
    reload.id = 'reauth-btn'
    reload.type = 'button'
    reload.textContent = '重新登入'
    reload.addEventListener('click', () => location.reload())
    prompt.appendChild(message)
    prompt.appendChild(reload)
    document.body.appendChild(prompt)
  }

  root.querySelector('#view-switch')!.addEventListener('click', event => {
    const target = (event.target as HTMLElement)
      .closest<HTMLButtonElement>('[data-view]')
    if (!target) return
    showView(
      target.dataset['view'] as 'entry' | 'recent' | 'outstanding',
    )
  })
  refreshTransactions.addEventListener('click', () => {
    void loadRecentTransactions()
  })
  transactionList.addEventListener('click', event => {
    const target = (event.target as HTMLElement)
      .closest<HTMLButtonElement>('[data-reverse-txn-id]')
    if (!target) return
    const txnId = target.dataset['reverseTxnId']
    const transaction = recentTransactions
      .find(candidate => candidate.txn_id === txnId)
    if (transaction) openReversal(transaction)
  })
  refreshReceivables.addEventListener('click', () => {
    void loadOutstandingReceivables()
  })
  receivablesList.addEventListener('click', event => {
    const target = (event.target as HTMLElement)
      .closest<HTMLButtonElement>('[data-settle-txn-id]')
    if (!target) return
    const txnId = target.dataset['settleTxnId']
    const entry = receivableGroups
      .flatMap(group => group.entries)
      .find(candidate => candidate.txn_id === txnId)
    if (entry && !entry.view_only) openSettlement(entry)
  })
  cancelSettle.addEventListener('click', closeSettlement)
  confirmSettle.addEventListener('click', () => {
    void onConfirmSettlement()
  })
  cancelReverse.addEventListener('click', closeReversal)
  confirmReverse.addEventListener('click', () => {
    void onConfirmReversal()
  })

  root.querySelector('#type-toggle')!.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-type]')
    if (!target) return
    dispatch(State.setType(state, target.dataset['type'] as State.TransactionType))
  })

  root.querySelector('#keypad')!.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-key]')
    if (!target) return
    dispatch(State.pressKey(state, target.dataset['key'] ?? ''))
  })

  accountPicker.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-account]')
    if (!target) return
    dispatch(State.selectAccount(state, target.dataset['account']!))
  })

  toAccountPicker.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-account]')
    if (!target) return
    dispatch(State.selectToAccount(state, target.dataset['account']!))
  })

  categoryGrid.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-category]')
    if (!target) return
    dispatch(State.selectCategory(state, target.dataset['category']!))
  })

  iouToggle.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-iou]')
    if (!target) return
    dispatch(State.setIou(
      state,
      target.dataset['iou'] as '應收' | '應付',
    ))
  })

  payeeSuggestions.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-payee]')
    if (!target) return
    dispatch(State.setPayee(state, target.dataset['payee']!))
  })

  payeeInput.addEventListener('input', () => {
    dispatch(State.setPayee(state, payeeInput.value))
  })
  descriptionInput.addEventListener('input', () => {
    dispatch(State.setDescription(state, descriptionInput.value))
  })
  dateInput.addEventListener('input', () => {
    dispatch(State.setDate(state, dateInput.value))
  })
  submitButton.addEventListener('click', () => { void onSubmit() })

  render()
  const loadedOptions = loadOptions()
  if (loadedOptions.cached) applyOptions(loadedOptions.cached)
  void loadedOptions.refresh.then(refreshed => {
    if (!stopped && refreshed) applyOptions(refreshed)
  })

  const sessionGuard = startSessionGuard({
    check: authCheck,
    onExpired: showReauthPrompt,
  })
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') sessionGuard.onVisible()
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  return () => {
    stopped = true
    sessionGuard.stop()
    document.removeEventListener('visibilitychange', onVisibilityChange)
    if (resetTimer) clearTimeout(resetTimer)
    document.querySelector('#reauth-prompt')?.remove()
  }
}

function showFlash(text: string): void {
  const flash = document.createElement('div')
  flash.className = 'flash-overlay'
  flash.textContent = text
  document.body.appendChild(flash)
  setTimeout(() => flash.remove(), 700)
}

if (!import.meta.env.VITEST) {
  mountApp(document.querySelector<HTMLElement>('#app')!)
  if ('serviceWorker' in navigator) {
    void navigator.serviceWorker.register('/sw.js')
  }
}
