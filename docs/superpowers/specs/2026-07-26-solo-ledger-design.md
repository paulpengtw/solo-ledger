# solo-ledger — Personal Double-Entry Expense PWA — Design

Date: 2026-07-26
Status: approved design (brainstorming session); revised after adversarial spec review and user grilling session 2026-07-26

## 1. Purpose

A separate, personal-only fork of the expense-pwa architecture: a mobile PWA for
fast expense/income/transfer entry into the user's own Google Spreadsheet,
kept as a true double-entry book. It removes every two-person household
mechanism (payer/bearer 翊/cheng, 平分拆帳, settlement sheets, Hermes coupling)
and is built so that **frequent schema changes are sheet edits, not code
deploys**, including a future migration to a brand-new spreadsheet.

Success criteria:

- One Moneybook/YNAB-style input posts one balanced debit/credit journal row.
- Adding an account, category, or payee never requires a deploy.
- Adding/reordering journal columns never requires a deploy.
- Migrating to a new spreadsheet requires zero code changes.
- Hand edits to the sheet cannot silently corrupt balances undetected.

## 2. Alternatives considered

- **A. Minimal fork** (vocabulary hardcoded in `src/options.ts`): rejected —
  every vocabulary change costs a git push + Pages deploy; rebuilds the
  rigidity the user is escaping; no hand-edit safety net.
- **B. Sheet-defined schema with fully dynamic form rendering** (欄位定義
  registry tab): rejected — a typo'd registry cell bricks the only input form
  at runtime on the phone; two-header-row journal breaks normal sheet
  ergonomics; triples validation/test surface.
- **C. Balanced-pair journal + sheet-resident chart of accounts, pure form**:
  closest, but multi-row compound transactions break the inherited idempotency
  guarantee, colon-path account names make renames rewrite history, and 12 API
  actions is v1 overreach.
- **D (chosen): synthesis** — C's spine (header-name column resolution,
  sheet-resident COA, consistency checking), A's scope discipline (one row per
  create, static form), B's best tabs (選項清單, 設定, in-GAS bootstrap), plus
  fixes to idempotency bugs inherited from the production Code.js.

## 3. Architecture

```
Browser PWA (Vite+TS, zh-TW, iOS-optimized)
    │  POST /api/<action>   (CF_Authorization cookie)
    ▼
Cloudflare Pages Function
    │  verify Cloudflare Access JWT (allowlist: the user's single email)
    │  structural validation only (types, amount > 0, date shape)
    │  build HMAC-SHA256 envelope { ts, nonce, payload, sig }
    ▼
Apps Script web app (execute-as-me)   apps-script/Code.gs
    │  verify signature + timestamp skew (lock-free)
    │  acquire LockService → nonce check → vocabulary validation vs 會計科目
    │  → txn_id-uniqueness backstop scan → expandPosting_ → append row
    │  → commit nonce→result → release lock
    ▼
Google Spreadsheet (the only datastore)
```

Division of validation labor (the flexibility pivot): the Pages Function
validates **structure only**; **vocabulary** (accounts, categories, payees) is
validated by Code.gs **against the sheet itself**, so vocabulary never lives in
deployed code.

Repo: one new monorepo (working name `solo-ledger`):

```
solo-ledger/
├── src/                  # PWA (forked shell from expense-pwa)
├── functions/
│   ├── api/[action].ts   # verbatim fork
│   └── lib/              # envelope.ts, jwt.ts verbatim; handler.ts, validate.ts rewritten
├── apps-script/Code.gs   # new standalone script, pushed via clasp
├── scripts/gen-fixture.py# adapted fork: inlines envelope signing (HMAC-SHA256 over
│                         #   ts.nonce.payloadB64, base64url), emits a create_transaction
│                         #   payload; no import from the Hermes python client
├── tests/                # vitest
└── README.md / DEPLOY.md / CONTEXT.md
```

Cloudflare Access application: one email, one-time PIN login, 1-month session
(same setup as expense-pwa, minus the second person).

## 4. Spreadsheet layout

| Tab | Written by | Purpose |
|---|---|---|
| `日記帳` | code, plus occasional hand rows (marked 來源=手動) | Journal. Single zh-TW header row (row 1), data from row 2. No formulas ever on this tab. |
| `會計科目` | user, by hand | Chart of accounts: `名稱`, `類型` (資產/負債/收入/支出/權益), `子類型` (free text, used only for picker grouping), `啟用` (TRUE/FALSE), `排序` (number). Categories are rows here too (類型=收入 or 支出) — one tab holds the entire vocabulary. Plain unique display names; **no colon or path separators in names**. |
| `選項清單` | user, by hand | Named enum lists, one list per column: row 1 = list name (v1 ships one column, `對象`), rows 2+ = values. |
| `設定` | user, by hand | Key/value rows, columns `設定項目` / `值`. v1 keys: `預設幣別` (TWD), `預設帳戶` (an account name). Unknown keys ignored. |
| `餘額` | formulas only | Per-account live balance: SUMIFS over 借方帳戶/貸方帳戶, signed by 類型; columns located via INDEX/MATCH on header names. |
| `試算與檢查` | formulas only | Trial balance (total debits == total credits), unknown-account detector, 結清狀態-vs-derived-balance cross-check (scoped per §5.4), non-text 日期/時間 cell detector. |

`日記帳` required headers (15):

```
日期 · 時間 · 類型 · 借方帳戶 · 貸方帳戶 · 金額 · 幣別 · 分類 · 對象 · 說明 ·
結清狀態 · 沖銷txn_id · txn_id · 來源 · 建立時間
```

Column semantics:

- **Code.gs resolves every column by header name, per call.** Adding,
  reordering, or renaming *extra* columns is free. Deleting or renaming one of
  the 15 required headers fails loudly, naming the missing header.
- `類型` ∈ {`支出`, `收入`, `轉帳`, `沖銷`} (closed enum; `沖銷` is written
  only by `reverse_transaction`).
- `分類` = the name of the nominal account (a 會計科目 row with 類型=收入 or
  支出) appearing in either leg of the row; **blank when neither leg is
  nominal** (transfers, 代墊, settlements). One rule, no exceptions.
- `對象` = payee/counterparty display name (free text, suggested from
  選項清單). Required when `iou` is set.
- `結清狀態` ∈ {blank, `未結`, `部分`, `已結`, `已沖銷`}. Blank for ordinary
  rows. Set to `未結` at creation of an 應收/應付 row; recomputed to `部分` or
  `已結` from settlement arithmetic (§5.3); `已沖銷` when the row is reversed.
  "Open" rows (for lists and outstanding math) = {`未結`, `部分`}.
- `沖銷txn_id` = on a settlement or reversal row, the `txn_id` of the original
  row it settles/reverses; blank otherwise. Originals are never edited except
  the `結清狀態` cell.
- `txn_id` = the client-generated idempotency key (UUIDv4), one per journal
  row. Hand rows may leave it blank (such rows are invisible to
  txn_id-addressed actions). Doubles as the dedupe fingerprint for any future
  bank-CSV import.
- `來源` ∈ {`pwa`, `手動`, `移轉`, future `import`}.
- `金額` is always positive; direction lives entirely in the debit/credit legs.
- `日期` = `YYYY-MM-DD`; `時間` = `HH:mm`, blank when the user omits it;
  `建立時間` = ISO-8601 with `+08:00` offset. All three are written as plain
  text; `setupSpreadsheet()` sets those columns' number format to text (`@`).
  The same `YYYY-MM-DD` string is the API wire format for all date fields.

## 5. Posting rules (single input → true double entry)

One `create_transaction` = **exactly one balanced journal row** (one debit
account, one credit account, one amount). The book balances by construction;
no hand edit can unbalance a single row.

### 5.1 Column-complete posting table

Every row below also writes: 金額 (positive), 幣別, 說明, 對象 (as noted),
txn_id = idempotencyKey, 來源=pwa, 建立時間 = server now. "分類" follows the
§4 rule automatically; it is listed for clarity.

| Case | 類型 | 借方帳戶 | 貸方帳戶 | 分類 | 結清狀態 | 沖銷txn_id |
|---|---|---|---|---|---|---|
| 支出 from asset (現金/銀行/悠遊卡) | 支出 | the category | the asset account | the category | blank | blank |
| 支出 by credit card | 支出 | the category | that card's 負債 account | the category | blank | blank |
| 轉帳 (繳卡費, 悠遊卡加值, …) | 轉帳 | to-account | from-account | blank | blank | blank |
| 收入 | 收入 | receiving account | the income category | the category | blank | blank |
| 代墊 (`iou: '應收'`) | 支出 | 應收帳款 | paying account | blank | 未結 | blank |
| Friend paid for user (`iou: '應付'`) | 支出 | the category | 應付帳款 | the category | 未結 | blank |
| Settle (collect 應收 / repay 應付) | 轉帳 | derived (§5.3) | derived (§5.3) | blank | blank | original txn_id |
| Opening balance (bootstrap/migration) | 轉帳 | asset account | 期初餘額 (類型=權益) | blank | blank | blank |
| Reverse (mistake) | 沖銷 | original 貸方 | original 借方 | per §4 rule | blank | original txn_id |

Account names in this table are descriptions, not literal names: "that card's
負債 account" means whatever the user named it in 會計科目 (e.g. `國泰卡`);
`期初餘額`, `應收帳款`, `應付帳款` are seeded by `setupSpreadsheet()` as plain
names with the stated 類型. Liability opening balances mirror the asset rule
(credit the liability, debit 期初餘額).

### 5.2 Per-type field matrix for create_transaction

| Field | 支出 | 收入 | 轉帳 |
|---|---|---|---|
| account (paying/receiving) | required | required | required (from) |
| toAccount | rejected | rejected | required |
| category | required; rejected when `iou:'應收'` | required | rejected |
| payee | optional; required when iou set | optional | rejected |
| iou | optional | rejected | rejected |

Presence rules are enforced by Code.gs (vocabulary layer); the Pages Function
checks structure only. Fields marked "rejected" cause a named error, not
silent dropping — a stale field after a type toggle must fail loudly.

### 5.3 Settlement (`settle` action) semantics

- Orientation is derived from the original row (looked up by txn_id): if the
  original's **debit** leg is 應收帳款, the settlement row is debit
  `account` (money received) / credit 應收帳款; if the original's **credit**
  leg is 應付帳款, the settlement row is debit 應付帳款 / credit `account`
  (money paid out).
- `amount` omitted → remaining outstanding. `amount` > remaining outstanding →
  named error.
- Outstanding(original) = original 金額 − Σ 金額 of rows whose 沖銷txn_id =
  original txn_id and 類型=轉帳. After each settle, the original's 結清狀態
  cell is recomputed: outstanding = 0 → `已結`, else `部分`.
- Settlement rows and 沖銷 mirror rows stamp 幣別 = the 設定 default (預設幣別).
  `settle` returns a named error when the original row's 幣別 differs from the
  default (v1 answer: settle foreign-currency rows by hand). Neither `settle`
  nor `reverse_transaction` accepts a currency input.
- Writes are ordered settlement-row-first, status-cell-second; a crash between
  the two leaves arithmetic truth intact (status is a cache) and
  `check_consistency` flags/repairs the stale cell.

### 5.4 Reversal semantics

- `reverse_transaction` may target only ordinary rows: 類型 ∈ {支出, 收入, 轉帳}
  AND the row is not a settlement row (類型=轉帳 with 沖銷txn_id set) AND not a
  沖銷 row. Targeting a settlement or 沖銷 row → named error.
- The mirror row writes 沖銷txn_id = original txn_id.
- Reversing a row whose 結清狀態 ∈ {未結, 部分} sets the original's status to
  `已沖銷`; such rows leave lists and outstanding math. Reversing an original
  that already has settlements is rejected with a named error; a mistaken
  settlement is corrected by a documented manual procedure — hand-delete the
  settlement row in the sheet, then `check_consistency` repairs the stale
  結清狀態 cell.
- The 試算與檢查 status cross-check applies only to rows with 結清狀態 set;
  the 分類-consistency check applies only to rows with a nominal leg.

### 5.5 Deliberate constraints

- A split purchase (e.g. groceries partly 代墊) = **two creates** with two
  idempotency keys, presented as one split screen in the PWA. Rationale:
  one-nonce-one-row keeps retry-idempotency airtight — a mid-write crash can
  never half-post a transaction.
- 悠遊卡/cash drift reconciliation is a v1 *workflow*, not an action: check
  餘額 in the Sheets app, then enter one adjustment 支出 with 分類=調整支出 or
  收入 with 分類=調整收入 (both seeded by `setupSpreadsheet()`). A one-tap
  reconcile screen is deferred to v2.

## 6. API contract

Envelope: `{ ts, nonce, payload, sig }`, HMAC-SHA256, ±300 s skew — ported,
with these fixes to bugs inherited from the production expense-hermes Code.js:

1. **Lock before nonce.** Signature and timestamp-skew verification are
   lock-free; then LockService is acquired and the nonce check, vocabulary
   validation, write, and nonce commit all happen inside the lock. (Production
   checks-and-commits the nonce before the write, outside any lock — both a
   lost-entry bug and a same-nonce race.)
2. **Nonce committed only after a successful write**, as `nonce → result`
   (CacheService, 600 s TTL). A replayed create returns the stored result with
   `already: true` added. The taxonomy change for the client: the old
   `replayed nonce`-string → success mapping is deleted; the PWA reads
   `already` from the response body.
3. **Durable idempotency backstop**: because txn_id = idempotencyKey, `create`
   and `settle` scan the txn_id column for the key before appending (covers
   CacheService eviction). Personal-scale row counts make this cheap.
4. **Mutating non-create actions are idempotent too**: `settle` and
   `reverse_transaction` use the idempotencyKey as nonce; their "already done"
   pre-checks read the journal, not the status cache: settle → a row with
   txn_id = key exists, or outstanding ≤ 0 → `{ ok, already: true }`; reverse
   → any 類型=沖銷 row with 沖銷txn_id = target → `{ ok, already: true }`.

`schema_version` = first 12 hex chars of SHA-256 over the canonical JSON
serialization (row-major arrays of display values of the used ranges) of
會計科目 + 選項清單 + 設定, computed by one shared function used by both
`health` and `get_options`.

Actions (9):

| Action | Contract |
|---|---|
| `health` | → `{ ok, now, schema_version, spreadsheet_id_tail }` |
| `auth-check` | Pages-Function-only; returns Access JWT expiry for the visibilitychange re-check flow (ported) |
| `get_options` | → `{ schema_version, accounts: [{name, type, subtype, sort}] (啟用 only, real accounts: 類型 資產/負債), categories: { 支出: [names], 收入: [names] } (啟用 only), payees: [names], defaults: { currency, account } }` |
| `create_transaction` | `{ type: 支出\|收入\|轉帳, date, time?, amount, currency?, account, toAccount?, category?, payee?, description, iou?: 應收\|應付 }` + idempotencyKey→nonce. Validates per §5.2 against 會計科目 (must be 啟用), expands per §5.1, appends one row. Omitted time → blank cell; omitted currency → 設定 default |
| `list_transactions` | `{ date_from, date_to }` (YYYY-MM-DD, inclusive) → rows newest-first, max 200: `{ txn_id, 日期, 時間, 類型, 借方帳戶, 貸方帳戶, 金額, 幣別, 分類, 對象, 說明, 結清狀態 }` as written (text strings) |
| `list_receivables` | rows with 結清狀態 ∈ {未結, 部分}, grouped by 對象, each with direction (應收/應付) and computed outstanding per §5.3; includes hand rows (來源=手動, blank txn_id) returned as view-only entries (no txn_id → no settle button; outstanding = full 金額; lifecycle by hand) |
| `settle` | `{ txn_id, account, date, amount? }` + idempotencyKey → settlement row per §5.3 + status recompute; partial OK; idempotent per fix 4. Settles both 應收 and 應付 (orientation derived). `account` must name an existing, 啟用 real account (類型 資產/負債) — derived legs (應收帳款/應付帳款 from the original) skip the 啟用 check. Returns a named error when the original's 幣別 differs from the 設定 default (stamp 幣別 = default; no currency input) |
| `reverse_transaction` | `{ txn_id, date }` + idempotencyKey → mirror row per §5.4; rejects settlement and 沖銷 rows (named error); idempotent per fix 4. All legs derived → full 啟用 exemption (may reference since-disabled accounts). Stamps 幣別 = 設定 default; no currency input |
| `check_consistency` | audit report: unknown/disabled accounts in journal, 分類 vs nominal-leg mismatch (nominal-leg rows only), 結清狀態 vs derived outstanding (status-bearing rows only, regardless of 來源), stale status cells (repairable), non-positive amounts, non-text 日期/時間 cells, stray cells below the journal, 沖銷 rows without 沖銷txn_id, linked-row 幣別 mismatch (settlement/沖銷 rows whose 幣別 differs from their linked original's); installable as a weekly trigger that emails on failure |

`setupSpreadsheet()` (bootstrap) and `closeAndOpenBooks()` (migration) are
**editor-run only**, never routed through `doPost`.

## 7. PWA UI

Forked Wise-style shell: type toggle 支出/收入/轉帳 → amount keypad → account
picker (grouped by 子類型) → category grid (per-type list from get_options) →
optional 對象 row with 代墊(應收)/應付 toggles → submit. Two additional
screens: recent entries (list_transactions); outstanding 應收/應付 grouped by
對象 with one-tap settle.

The form is **static code** (no dynamic field renderer), but every option list
comes from `get_options` (localStorage cache, background refresh). On
`schema_version` change mid-session: soft warning banner only, never a hard
block.

Input principle — **selection-first, mobile-first**: accounts, categories, and
counterparties are tap targets drawn from `get_options`; typing is reserved for
the amount keypad and free-form text fields (說明, custom 對象 entry). 說明
(description) is deliberately required: the user enters it via speech-to-text
so that every row carries a narrative — future maintainers must not make it
optional.

## 8. Error handling

- PWA: 15 s timeout; retries reuse the idempotency key; replay detection via
  `already: true` in response bodies (see §6 fix 2); no offline queue.
- Pages Function: 401 bad/missing JWT; 400 structural; GAS errors forwarded
  verbatim.
- Code.gs: unknown/disabled account or category → error naming the value;
  missing required header → error naming the header; §5.2 "rejected" fields →
  error naming the field; over-settlement → error; all mutations inside
  LockService.
- Hand-edit safety net: COA-fed data-validation dropdowns on 借方帳戶/貸方帳戶
  (advisory), 試算與檢查 tab always on, `check_consistency` weekly email
  trigger. Manual procedure for a mistaken settlement (settlements are
  irreversible via API in v1): hand-delete the settlement row in the sheet,
  then run `check_consistency` — it detects and repairs the stale 結清狀態
  cell on the original row.
- Documented operating rule: **never sort 日記帳 in place** (filter views
  only); the journal tab holds no formulas.

## 9. Testing

- Fork the envelope/JWT vitest suites (near-verbatim; they test
  contract-independent crypto/JWT plumbing). handler/validate suites are
  **rewritten** against the new 9-action contract. `gen-fixture.py` is adapted
  (see §3) and regenerated fixtures keep byte-parity between Python and TS
  envelope builders.
- Posting engine: `expandPosting_(input)` in Code.gs is a **pure function**
  (no GAS API calls). Vitest evals Code.gs with stubbed GAS globals and runs:
  table tests for every §5.1 row, the §5.2 matrix (required/rejected), §5.3
  orientation+outstanding cases, and a **property test: for every representable
  input, debits == credits**. Single implementation — no TS mirror, no drift.
- Header resolution: reorder/insert/rename-extra → works; delete required
  header → loud named failure.
- Manual smoke checklist in README: Access gate 401 unauthenticated, `health`
  from phone, one real entry visible in the sheet, PWA home-screen install,
  visibilitychange re-auth.

## 10. Ops, migration, backup

- **Bootstrap**: create a blank spreadsheet → paste its ID into Script
  Property `LEDGER_SPREADSHEET_ID` → run `setupSpreadsheet()` in the Apps
  Script editor: builds all tabs and headers, sets text format (`@`) on
  日期/時間 columns, installs formulas and dropdown validations, seeds
  會計科目 with 期初餘額(權益), 應收帳款(資產), 應付帳款(負債),
  調整支出(支出), 調整收入(收入) plus starter accounts. Script Properties:
  `EXPENSE_API_SECRET`, `LEDGER_SPREADSHEET_ID`. Pages env vars: same four
  names as expense-pwa. Opening-balance rows at bootstrap are a hand-row
  procedure (typed directly into 日記帳, 來源=手動); 期初餘額 is a 權益
  account and intentionally absent from `get_options` and the PWA pickers.
- **Migration to a new spreadsheet** (Path A, fresh book): (1) create blank
  spreadsheet, run `setupSpreadsheet()` against it (operator temporarily
  points `LEDGER_SPREADSHEET_ID` at the new ID); (2) run
  `closeAndOpenBooks(oldSpreadsheetId)`, which reads the OLD book and writes
  into the NEW (current) book: per-account opening-balance rows at balances
  as of migration (assets and liabilities, against 期初餘額, 來源=移轉), plus
  one row per still-open 應收/應付 item **at its remaining outstanding** (fresh
  txn_id, 來源=移轉, 結清狀態=未結, original description prefixed `承前-`;
  linked settlement history intentionally stays in the old book); (3) run `check_consistency`;
  (4) confirm `health` shows the new `spreadsheet_id_tail`. Path B (full
  history): File → Make a copy, point the Script Property at the copy. Zero
  code changes either way.
- **Backup**: weekly GAS time-driven trigger copies the spreadsheet to a Drive
  backup folder (the sheet is the only datastore); the trigger prunes the
  backup folder to the 12 most recent copies (timestamped names).
- Pinned contracts: `appsscript.json` timeZone `Asia/Taipei`; date/time
  formats per §4; data rows start at row 2.

## 11. Build order (three independently verifiable phases)

1. **Spine**: Code.gs envelope layer with §6 fixes 1–3 + `health` +
   `create_transaction` + `expandPosting_` + `setupSpreadsheet()`; rewritten
   Pages functions; adapted gen-fixture.py; envelope/posting tests green; one
   real row appended end-to-end.
2. **Vocabulary & form**: `get_options` + schema_version + 餘額/試算與檢查
   formulas + the PWA entry form + auth-check flow; entry usable daily from
   the phone.
3. **Receivables & ops**: `list_transactions`, `list_receivables`, `settle`,
   `reverse_transaction`, `check_consistency` + the two PWA screens + weekly
   backup/consistency triggers + `closeAndOpenBooks()`.

Each phase gets its own implementation plan and review checkpoint.

## 12. Non-goals (v1)

- Offline queue / background sync
- Budgets; reports beyond the 餘額/試算與檢查 formula tabs
- Multi-currency balance math (幣別 stored; totals assume TWD)
- Bank-CSV import (txn_id doubles as the dedupe fingerprint, reserved for a
  later re-port of the masobu-style import)
- Edit-in-place (`reverse` + re-enter instead); reversing an original that
  already has settlements (kept strict in v1, see §5.4)
- Dynamic form fields (new *form fields* cost a small code edit + Pages
  auto-deploy — accepted trade-off)
- Dedicated one-tap reconcile screen (v2)
