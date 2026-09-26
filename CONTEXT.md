# solo-ledger

Personal double-entry expense ledger: a mobile PWA posts balanced journal rows
into the user's own Google Spreadsheet, which is the only datastore.

## Language

### The book

**日記帳 (Journal)**:
The append-only book of all postings; one row = one balanced debit/credit
pair with a single positive 金額.
_Avoid_: transactions sheet, log

**會計科目 (Chart of accounts)**:
The sheet-resident vocabulary of every posting target — real accounts and
categories live in the same list.
_Avoid_: options list, vocabulary tab

**Real account (帳戶)**:
A 會計科目 row with 類型 資產 or 負債 — something that holds a balance
(cash, bank, credit card, 悠遊卡).
_Avoid_: wallet

**Category (分類)**:
A nominal 會計科目 row with 類型 收入 or 支出; posts as a journal leg like
any account. A row's 分類 column names the nominal leg, blank when neither
leg is nominal.
_Avoid_: tag, label

**交易對象 (Counterparty)**:
The person or merchant a row relates to; free text, suggested from 選項清單.
_Avoid_: 對象 (legacy header spelling), vendor, payee.

**來源 (Source)**:
Which writer produced a journal row: `pwa`, `手動` (hand-entered), `移轉`
(migration-written), or a future `import`.

**txn_id**:
Client-generated UUID naming one journal row; doubles as the idempotency
key. Hand rows may omit it and are then invisible to txn_id-addressed
actions.

### Receivables and corrections

**代墊**:
An expense the user fronted for someone else — posts against 應收帳款
instead of a category; the money is owed back, not spent.

**應收帳款 / 應付帳款 (Receivable / Payable)**:
The single aggregate accounts for money owed to / owed by the user;
per-counterparty detail lives in each row's 交易對象.

**Settlement (settle)**:
A 轉帳 row that pays down an open 應收/應付 row, linked to it via
沖銷txn_id. Partial settlement is allowed.

**Reversal (沖銷)**:
A mirror row that voids an earlier row, linked via 沖銷txn_id. The only
correction mechanism — there is no edit-in-place.
_Avoid_: delete, undo, edit, 調整 (that word means the drift-reconciliation categories 調整支出/調整收入)

**Stable identity repair**:
An explicit, reviewed adoption of an identity for a legacy row that has none.
Under the locked repair path, adoption may fill only a blank txn_id identity
cell; financial and source cells remain immutable, and corrections remain
reversal-only.

**Account alias**:
A strict, deliberate historical name for one 會計科目 row. An alias preserves
historical journal readability after a rename; an ambiguous alias is unavailable
rather than guessed.

**結清狀態 (Settlement status)**:
Cached state of an 應收/應付 row: 未結 / 部分 / 已結 / 已沖銷. The journal
arithmetic is the truth; this cell is a recomputable cache. "Open" rows =
{未結, 部分}.
_Avoid_: 收款狀態

**Outstanding**:
The remaining unsettled amount of an 應收/應付 row — always derived from
journal arithmetic, never stored.

### Ops

**期初餘額 (Opening balance)**:
The equity account that absorbs opening entries at bootstrap and at
migration to a fresh book.

**schema_version**:
Fingerprint of the sheet-resident vocabulary (會計科目 + 選項清單 + 設定);
changes when the user edits vocabulary by hand.
