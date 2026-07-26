# solo-ledger — Personal Double-Entry Expense PWA — Design

Date: 2026-07-26
Status: approved by user (brainstorming session), pending final spec review

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
  guarantee, colon account paths (`支出:食:個人`) make renames rewrite history,
  and 12 API actions is v1 overreach.
- **D (chosen): synthesis** — C's spine (header-name column resolution,
  sheet-resident COA, consistency checking), A's scope discipline (one row per
  create, static form), B's best tabs (選項清單, 設定, in-GAS bootstrap), plus
  fixes to three idempotency bugs inherited from the production Code.js.

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
    │  verifyEnvelope_ → LockService → vocabulary validation vs 會計科目
    │  posting expansion → append one journal row
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
│   └── lib/              # envelope.ts, jwt.ts verbatim; handler.ts, validate.ts reworked
├── apps-script/Code.gs   # new standalone script (~350 lines), pushed via clasp
├── scripts/gen-fixture.py# verbatim fork (HMAC byte-parity fixtures)
├── tests/                # vitest
└── README.md / DEPLOY.md / CONTEXT.md
```

Cloudflare Access application: one email, one-time PIN login, 1-month session
(same setup as expense-pwa, minus the second person).

## 4. Spreadsheet layout

| Tab | Written by | Purpose |
|---|---|---|
| `日記帳` | code only | Journal. Single zh-TW header row (row 1), data from row 2. Pure data — never any formula. |
| `會計科目` | user, by hand | Chart of accounts: `名稱`, `類型` (資產/負債/收入/支出/權益), `子類型` (現金/銀行/信用卡/儲值卡/…), `啟用`, `排序`. Categories are rows here too (類型=收入 or 支出) — one tab holds the entire vocabulary. Plain unique display names; **no colon paths**. |
| `選項清單` | user, by hand | Named enum lists: `對象` (payees), plus any future dropdown list. |
| `設定` | user, by hand | Runtime knobs: default currency, default account, journal tab name. |
| `餘額` | formulas only | Per-account live balance: SUMIFS over 借方帳戶/貸方帳戶, signed by 類型; columns located via INDEX/MATCH on header names. |
| `試算與檢查` | formulas only | Trial balance (total debits == total credits), unknown-account detector, 收款狀態 vs derived AR/AP balance cross-check. |

`日記帳` required headers (15):

```
日期 · 時間 · 類型 · 借方帳戶 · 貸方帳戶 · 金額 · 幣別 · 分類 · 對象 · 說明 ·
收款狀態 · 沖銷txn_id · txn_id · 來源 · 建立時間
```

- **Code.gs resolves every column by header name, per call.** Adding,
  reordering, or renaming *extra* columns is free. Deleting or renaming one of
  the 15 required headers fails loudly, naming the missing header.
- `分類` is a denormalized reporting copy; the 借方/貸方 legs are authoritative.
  `check_consistency` cross-checks the two.
- `來源` ∈ {`pwa`, `手動`, future `import`}. A fingerprint convention (txn_id
  doubles as dedupe key for imports) is reserved so a masobu-style bank-CSV
  import can be re-ported later.
- `金額` is always positive; direction lives entirely in the debit/credit legs.

## 5. Posting rules (single input → true double entry)

One `create_transaction` = **exactly one balanced journal row** (one debit
account, one credit account, one amount). The book balances by construction;
no hand edit can unbalance a single row.

| User input | Row written |
|---|---|
| 支出 paid from asset (現金/銀行/悠遊卡) | debit 分類 / credit that asset account |
| 支出 paid by credit card | debit 分類 / credit 負債:該卡 |
| 繳卡費, 悠遊卡加值 (轉帳) | debit to-account / credit from-account; 分類 blank |
| 收入 | debit receiving account / credit 分類(收入) |
| 代墊 for someone (toggle + 對象) | debit 應收帳款 / credit paying account; 收款狀態=未收 |
| Friend paid for the user (應付 toggle) | debit 分類 / credit 應付帳款; 對象 set; 收款狀態=未收 |
| Collect / repay | transfer row against 應收帳款/應付帳款; `沖銷txn_id` links to the original; partial amounts allowed; original's 收款狀態 → 已收 or 部分 |
| Opening balance | ordinary row: debit asset / credit 權益:期初餘額 (餘額 stays a pure formula, zero special cases) |
| Mistake | `reverse_transaction`: mirror row, 類型=調整; no deletes via API |

- 應收帳款 and 應付帳款 are single accounts in 會計科目; per-person tracking is
  via the `對象` column. Outstanding per 對象 = sum of uncollected rows minus
  linked 沖銷 rows.
- A split purchase (e.g. groceries partly 代墊) = **two creates**, presented as
  one split screen in the PWA. Rationale: one-nonce-one-row keeps
  retry-idempotency airtight — a mid-write crash can never half-post a
  transaction.
- 悠遊卡/cash drift reconciliation is a v1 *workflow*, not an action: check
  餘額 in the Sheets app, enter one adjustment 支出/收入 with 分類=調整. A
  one-tap reconcile screen is deferred to v2.

## 6. API contract

Envelope: `{ ts, nonce, payload, sig }`, HMAC-SHA256, ±300 s skew, replay
cache — ported, with three fixes to bugs inherited from the production
expense-hermes Code.js:

1. **Nonce committed only after a successful write.** (Current production
   caches the nonce during verify, before the write: a failed write + client
   retry returns `replayed nonce`, which the client maps to success — a
   silently lost entry.) New: cache `nonce → result` post-write; replays return
   the stored result.
2. **LockService wraps verify+write**, closing the CacheService check-then-put
   race (timeout-retry landing while the first call still runs).
3. **Mutating non-create actions are idempotent too**: `collect_receivable`
   and `reverse_transaction` take the PWA idempotencyKey as nonce and pre-check
   state (already collected/reversed → `{ ok, already: true }`).

Actions (9):

| Action | Contract |
|---|---|
| `health` | → `{ ok, now, schema_version, spreadsheet_id_tail }` |
| `auth-check` | Pages-Function-only; returns Access JWT expiry for the visibilitychange re-check flow (ported) |
| `get_options` | reads 會計科目 + 選項清單 + 設定 → grouped accounts, categories, payees, defaults, `schema_version` (content hash of the vocabulary tabs). PWA caches in localStorage, background-refreshes |
| `create_transaction` | `{ type: 支出\|收入\|轉帳, date, time?, amount, currency?, account, toAccount?, category?, payee?, description, ar? }` + idempotencyKey→nonce. GAS validates vocabulary, expands per §5, appends one row |
| `list_transactions` | `{ date_from, date_to }` → recent entries (row data incl. txn_id) |
| `list_receivables` | open 應收/應付 grouped by 對象, each with computed outstanding |
| `collect_receivable` | `{ txn_id, account, date, amount? }` → settlement row + status flip; partial OK; idempotent |
| `reverse_transaction` | `{ txn_id, date }` → mirror legs, 類型=調整; idempotent |
| `check_consistency` | audit report: unknown/disabled accounts in journal, 分類 vs nominal-leg mismatch, 收款狀態 vs derived balance, non-positive amounts, stray cells below the journal; installable as a weekly trigger that emails on failure |

`setupSpreadsheet()` (bootstrap) and `closeAndOpenBooks()` (migration) are
**editor-run only**, never routed through `doPost`.

## 7. PWA UI

Forked Wise-style shell: type toggle 支出/收入/轉帳 → amount keypad → account
picker → category grid → optional 對象/代墊/應付 row → submit. Two additional
screens: recent entries; outstanding 應收/應付 with one-tap collect.

The form is **static code** (no dynamic field renderer), but every option list
comes from `get_options`. On `schema_version` change mid-session: soft warning
banner only, never a hard block.

## 8. Error handling

- PWA: 15 s timeout; error taxonomy ported from expense-pwa; retries reuse the
  idempotency key; no offline queue.
- Pages Function: 401 bad/missing JWT; 400 structural; GAS errors forwarded
  verbatim.
- Code.gs: unknown account/category → error naming the value; missing required
  header → error naming the header; all writes under LockService.
- Hand-edit safety net: COA-fed data-validation dropdowns on 借方帳戶/貸方帳戶
  (advisory), 試算與檢查 tab always on, `check_consistency` weekly email
  trigger.
- Documented operating rule: **never sort 日記帳 in place** (filter views
  only); the journal tab holds no formulas.

## 9. Testing

- Fork the passing envelope/JWT/handler vitest suites; keep `gen-fixture.py`
  byte-parity HMAC fixtures.
- Posting rules: table tests per §5 row, plus a **property test: for every
  representable input, debits == credits**.
- Header resolution: reorder/insert/rename-extra → works; delete required
  header → loud named failure.
- Drift guard: a vitest parses `Code.gs` and cross-checks its posting table
  against the TS preview copy.
- Manual smoke checklist in README: Access gate 401 unauthenticated, `health`
  from phone, one real entry visible in the sheet, PWA home-screen install,
  visibilitychange re-auth.

## 10. Ops, migration, backup

- **Bootstrap**: run `setupSpreadsheet()` in the Apps Script editor against a
  blank spreadsheet — builds all tabs, headers, formulas, dropdown
  validations. No xlsx template. Script Properties: `EXPENSE_API_SECRET`,
  `LEDGER_SPREADSHEET_ID`. Pages env vars: same four names as expense-pwa.
- **Migration to a new spreadsheet**: Path A `closeAndOpenBooks(oldId)` —
  fresh book carrying opening balances + still-open 應收/應付 rows (row-level
  history intentionally left behind); Path B — File → Make a copy (full
  history). Both end: paste new ID into the Script Property, run
  `check_consistency`, confirm `health` shows the new `spreadsheet_id_tail`.
  Zero code changes.
- **Backup**: weekly GAS time-driven trigger copies the spreadsheet to a Drive
  backup folder (the sheet is the only datastore).
- Pinned contracts: `appsscript.json` timeZone `Asia/Taipei`; 日期/時間 written
  as text with explicit formats (avoids Date-serial/1899-12-30 coercion bugs);
  data rows start at row 2.

## 11. Non-goals (v1)

- Offline queue / background sync
- Budgets; reports beyond the 餘額/試算與檢查 formula tabs
- Multi-currency balance math (幣別 stored; totals assume TWD)
- Bank-CSV import (fingerprint/txn_id convention reserved for later re-port)
- Edit-in-place (`reverse` + re-enter instead)
- Dynamic form fields (new *form fields* cost a small code edit + Pages
  auto-deploy — accepted trade-off)
- Dedicated one-tap reconcile screen (v2)
