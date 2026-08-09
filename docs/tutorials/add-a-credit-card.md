# Tutorial: add a credit card

How to add a credit card — or any new real account — to your ledger. The PWA
has no add-account screen; real accounts are hand-added rows in the
spreadsheet, and everything downstream picks them up automatically.

## 1. Add the account row

Open your ledger spreadsheet, go to the 會計科目 sheet, and append a row:

| 名稱 | 類型 | 子類型 | 啟用 | 排序 |
| --- | --- | --- | --- | --- |
| 信用卡 (or the card's name, e.g. 玉山卡) | 負債 | 信用卡 | TRUE | 130 |

- 類型 must be **負債** — that is what makes the row a real account that
  holds a balance, and a credit card holds money you owe. (Other hand-added
  accounts work the same way; use 資產 for things you own, such as another
  bank account or e-wallet.)
- 排序 only controls list order. The built-in real accounts use 100–120
  (現金 100, 銀行 110, 悠遊卡 120), so 130 slots the card after them.

## 2. Nothing else to wire up

- The 餘額 sheet's formulas already cover hand-added accounts — the card's
  balance appears there automatically.
- The PWA picks the account up on its next vocabulary refresh: hand-editing
  會計科目 changes the schema_version fingerprint, which invalidates the
  app's cached vocabulary.

## 3. Optional: record the current outstanding balance

If the card already carries debt, add one hand row to 日記帳:

| Column | Value |
| --- | --- |
| 日期 | today, `YYYY-MM-DD` |
| 類型 | 轉帳 |
| 借方帳戶 | 期初餘額 |
| 貸方帳戶 | 信用卡 |
| 金額 | current amount owed (positive) |
| 幣別 | TWD |
| 來源 | 手動 |

Leave the other columns (分類, 交易對象, 結清狀態, txn_id, …) blank. For an
資產 account the legs flip: debit the account, credit 期初餘額. Hand rows
without a txn_id cannot be targeted by settle/reverse actions, which is fine
for an opening entry.

## 4. Daily use

- A purchase on the card is a normal 支出 with the card as the paying
  account: debit the category, credit 信用卡.
- Paying the bill is a 轉帳 from 銀行 (or 現金) to 信用卡 — it reduces what
  you owe; it is not an expense.

## 5. 沖銷 and the card — when, and when not

沖銷 is the ledger's only correction mechanism: a mirror row that voids an
earlier row, linked to it via 沖銷txn_id. It records that an entry should
never have happened — it does not record real-world money movement.

- **Paying the bill is not a 沖銷.** The payment is real money moving, so it
  is the plain 轉帳 from step 4. No row links the payment to the charges it
  covers, and charge rows carry no 結清狀態 — settlement tracking exists
  only for 應收帳款/應付帳款 rows. The card's 餘額 netting toward zero is
  the whole reconciliation.
- **沖銷 a charge row to correct a mistake** — wrong amount, wrong account,
  duplicate entry. Reverse the bad row, then post a fresh correct one; there
  is no edit-in-place.
- **A merchant refund is also a 沖銷 of the original charge**: the purchase
  is undone, so voiding the row restores the card balance and the category
  totals in one step. Don't record a refund as 收入 — that inflates both
  income and expense stats. A 沖銷 always mirrors the full original 金額,
  so for a partial refund, 沖銷 the original charge and post a fresh 支出
  for the amount you actually kept.
