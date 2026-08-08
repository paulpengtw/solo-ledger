# Hand-added Account Balance Formulas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically add missing `餘額` formula rows when a hand-added `會計科目` account changes the server-side schema.

**Architecture:** Keep `餘額` append-only and aligned by row with `會計科目`. An idempotent installer writes only rows that do not yet exist, while a schema-fingerprint synchronizer called from `health_()` and `getOptions_()` repairs coverage during normal client refreshes. Existing formula-tab cells and the one-row-per-account shape remain unchanged.

**Tech Stack:** Google Apps Script JavaScript in `apps-script/Code.gs`, Vitest, and the repository's fake Google Apps Script spreadsheet harness.

## Global Constraints

- Preserve unrelated dirty-worktree edits, especially the in-progress `對象` → `交易對象` rename.
- Never prefill all physical `getMaxRows()` rows in `餘額`; write one formula row per existing account only.
- Preserve existing `餘額` and `試算與檢查` cells when setup or synchronization runs again.
- Use the existing `ROW()` alignment and header-name formula lookup conventions.
- Production changes require a regression test that failed before the implementation.

---

## Files and responsibilities

- Modify `apps-script/Code.gs`: make `installBalanceFormulas_()` append missing rows and add schema-driven synchronization at the two schema-returning endpoints.
- Modify `tests/setup.test.ts`: prove rerunning setup extends the balance table after an account is appended and preserves existing formula cells.
- Modify `tests/doPost.test.ts`: prove the server-side health refresh repairs the missing row after schema drift and remains idempotent on a second refresh.
- Create `docs/superpowers/specs/2026-08-08-balance-formulas-hand-added-accounts-design.md`: record the approved design.

### Task 1: Add failing regression tests

**Files:**
- Modify: `tests/setup.test.ts` near the existing setup idempotence tests.
- Modify: `tests/doPost.test.ts` near the existing health/schema-version tests.

**Interfaces:**
- Consumes: `FakeGasHarness.setupSpreadsheet()`, `FakeGasHarness.doPost()`, and the existing signed-request test helper.
- Produces: failing assertions that describe the missing balance row and the required append-only behavior.

- [ ] **Step 1: Add the setup rerun regression test.**

Append `['信用合作社', '資產', '銀行', true, 999]` to `會計科目` after bootstrap, save the existing first balance formula, run `setupSpreadsheet()` again, and assert:

```ts
expect(balances.getLastRow()).toBe(accounts.getLastRow())
expect(balances.getRange(accounts.getLastRow(), 1).getValues()[0]![0]).toContain("INDEX('會計科目'")
expect(balances.getRange(accounts.getLastRow(), 2).getValues()[0]![0]).toContain("MATCH(\"類型\"")
expect(balances.getRange(accounts.getLastRow(), 3).getValues()[0]![0]).toContain('$A' + accounts.getLastRow())
expect(balances.getRange(2, 3).getValues()[0]![0]).toBe(firstBalanceFormula)
```

- [ ] **Step 2: Add the server refresh regression test.**

Append a new enabled account after bootstrap, verify the balance sheet still ends at the old account count, call the existing `post(harness, { action: 'health' }, ...)` helper, then assert the new matching row has all three formulas. Capture the full balance table, call health again, and assert the table is unchanged.

- [ ] **Step 3: Run the focused tests and verify they fail for the missing-row behavior.**

Run:

```bash
npx vitest run tests/setup.test.ts tests/doPost.test.ts -t "balance|health refresh"
```

Expected result before production changes: the new setup test fails because the one-shot installer leaves `餘額` shorter than `會計科目`, and the health test fails because schema refresh does not add a row. Existing unrelated tests should not be changed to accommodate the failure.

### Task 2: Implement idempotent balance synchronization

**Files:**
- Modify: `apps-script/Code.gs` in `health_()`, `getOptions_()`, `setupSpreadsheet()`, and `installBalanceFormulas_()`.

**Interfaces:**
- Consumes: the current spreadsheet, `schemaVersion_(spreadsheet)`, `PropertiesService.getScriptProperties()`, and the existing installer inputs.
- Produces: an internal `ensureBalanceFormulas_(spreadsheet, schemaVersion)` helper with no API payload changes.

- [ ] **Step 1: Make `installBalanceFormulas_()` append-only.**

Retain the three-column/header guard. Replace the current all-account write with:

```js
var accountCount = accounts.getLastRow() - 1;
var existingBalanceCount = Math.max(0, sheet.getLastRow() - 1);
if (accountCount <= existingBalanceCount) {
  return;
}

var missingCount = accountCount - existingBalanceCount;
var accountTypes = accounts.getRange(
  existingBalanceCount + 2,
  2,
  missingCount,
  1,
).getValues();
```

Generate formula rows with `sheetRow = existingBalanceCount + index + 2`, and write them to `existingBalanceCount + 2` rather than row 2. Keep the current formulas, account-range bounds, and type-sign behavior unchanged.

- [ ] **Step 2: Add the schema-driven synchronizer.**

Define a script-property key and an `ensureBalanceFormulas_(spreadsheet, schemaVersion)` helper that:

1. Reads the last synchronized fingerprint.
2. Reads `會計科目`, `餘額`, and `日記帳`.
3. Calls `installBalanceFormulas_()` when the fingerprint differs or the balance data-row count is less than the account data-row count.
4. Stores the current fingerprint after the installer attempt.

The helper must leave the existing installer guard in place for malformed/user-owned balance sheets.

- [ ] **Step 3: Invoke synchronization without changing response values.**

In `health_()`, compute `schemaVersion_()` once, call `ensureBalanceFormulas_()`, and return the computed value. In `getOptions_()`, do the same before returning the options payload. The existing `setupSpreadsheet()` installer call remains in place so rerunning setup repairs rows directly.

- [ ] **Step 4: Run the focused tests and verify they pass.**

Run:

```bash
npx vitest run tests/setup.test.ts tests/doPost.test.ts -t "balance|health refresh"
```

Expected result: the new regression tests and all matching existing tests pass, including the existing user-cell preservation and setup-idempotence assertions.

### Task 3: Full verification and handoff

**Files:**
- Inspect: `apps-script/Code.gs`, `tests/setup.test.ts`, `tests/doPost.test.ts`.
- Inspect: `git diff` and `git status` to confirm unrelated work remains untouched.

**Interfaces:**
- Consumes: the completed implementation and focused test evidence.
- Produces: a verified working tree with the requested behavior and no regression failures.

- [ ] **Step 1: Run the complete Vitest suite.**

Run:

```bash
npm test
```

Expected result: Vitest exits with code 0 and reports zero failed tests.

- [ ] **Step 2: Run the production build.**

Run:

```bash
npm run build
```

Expected result: TypeScript checking and the Vite build both exit with code 0.

- [ ] **Step 3: Review the final diff.**

Run:

```bash
git diff -- apps-script/Code.gs tests/setup.test.ts tests/doPost.test.ts
git status --short
```

Confirm the balance change is append-only, no existing unrelated edits were reverted, and the final response reports any pre-existing dirty files separately.
