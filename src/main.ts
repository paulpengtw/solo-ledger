import './styles.css'
import {
  authCheck,
  listTransactions,
  loadOptions,
  submitTransaction,
  type AccountOption,
  type LedgerOptions,
  type LedgerTransaction,
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
      <h2 id="payee-heading">對象 <span>選填</span></h2>
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
  `

  const pageTitle = root.querySelector<HTMLElement>('#page-title')!
  const entryView = root.querySelector<HTMLElement>('#entry-view')!
  const recentView = root.querySelector<HTMLElement>('#recent-view')!
  const recentStatus = root.querySelector<HTMLElement>('#recent-status')!
  const transactionList = root.querySelector<HTMLElement>('#transaction-list')!
  const refreshTransactions = root.querySelector<HTMLButtonElement>(
    '#refresh-transactions',
  )!
  const schemaBanner = root.querySelector<HTMLElement>('#schema-banner')!
  const accountPicker = root.querySelector<HTMLElement>('#account-picker')!
  const toAccountPicker = root.querySelector<HTMLElement>('#to-account-picker')!
  const categoryGrid = root.querySelector<HTMLElement>('#category-grid')!
  const payeeSuggestions = root.querySelector<HTMLElement>('#payee-suggestions')!
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
      transactionList.appendChild(article)
    }
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
    renderTransactions(rows)
  }

  function showView(view: 'entry' | 'recent'): void {
    const recent = view === 'recent'
    entryView.hidden = recent
    recentView.hidden = !recent
    pageTitle.textContent = recent ? '最近紀錄' : '快速記帳'
    root.querySelectorAll<HTMLButtonElement>('#view-switch [data-view]')
      .forEach(element => {
        const selected = element.dataset['view'] === view
        element.classList.toggle('selected', selected)
        element.setAttribute('aria-pressed', String(selected))
      })
    if (recent) void loadRecentTransactions()
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
    root.querySelector<HTMLElement>('#to-account-section')!.hidden =
      state.type !== '轉帳'
    root.querySelector<HTMLElement>('#payee-section')!.hidden =
      state.type === '轉帳'

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
    showView(target.dataset['view'] as 'entry' | 'recent')
  })
  refreshTransactions.addEventListener('click', () => {
    void loadRecentTransactions()
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
