# Hand-added account balance formulas design

## Problem

Appending an enabled asset or liability account to `會計科目` updates the
runtime vocabulary, journal validation range, and audit formulas, but does not
add the corresponding per-account row to `餘額`. The current balance installer
only runs when `餘額` contains its header row, so an already initialized book
never gains formulas for later accounts.

## Selected approach

Make `installBalanceFormulas_()` append-only and idempotent. It will calculate
the number of existing balance data rows, generate formulas only for account
rows beyond that point, and write them starting at the first missing balance
row. Existing formula-tab cells therefore remain unchanged, preserving the
current setup idempotence contract.

Add a small server-side synchronization helper that stores the schema
fingerprint last checked for balance formulas. `health_()` and `getOptions_()`
already compute the current fingerprint; they will invoke the helper before
returning it. A changed fingerprint causes the helper to run the idempotent
installer, so the next normal client refresh repairs appended accounts. The
helper also checks row coverage even when the stored fingerprint matches, so a
manually removed balance row can be restored.

The existing `setupSpreadsheet()` call continues to use the same installer,
which means rerunning setup also repairs appended accounts without rewriting
existing rows. The fix will not prefill every physical row returned by
`getMaxRows()`, because that would create hundreds of blank balance lines and
would change the current one-row-per-account behavior.

## Data flow and failure behavior

1. `health_()` or `getOptions_()` computes `schemaVersion_(spreadsheet)`.
2. The sync helper compares that value with the stored script property and
   compares account-row count with balance-row count.
3. If coverage is stale, the installer appends formula rows using the existing
   `ROW()` alignment and journal header lookup conventions.
4. The helper records the checked schema fingerprint and the endpoint returns
   the same fingerprint it computed.

If the balance sheet does not have the expected three-column header shape, the
existing installer guard remains authoritative and no user sheet content is
overwritten. The endpoint behavior and schema-version payload remain unchanged
apart from the repair side effect.

## Testing

Add a regression test to the Apps Script setup/endpoint tests that bootstraps a
book, appends a real account to `會計科目`, invokes the server-side health path,
and asserts that the matching `餘額` row contains the expected name/type/balance
formulas. Invoke the path again and assert the row count and existing formula
cells remain unchanged. Keep the existing setup idempotence and user-cell
preservation tests green.
