# Rename Counterparty Header to 交易對象 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the canonical Chinese counterparty term from `對象` to `交易對象` across the Apps Script/API schema, PWA UI, tests, deployment documentation, glossary, and a new accepted ADR while preserving the English `payee` identifiers and applying the deliberate breaking sheet-schema migration.

**Architecture:** Keep `交易對象` as the single Chinese schema/property name at every boundary that represents a journal row or counterparty group, including the Apps Script sheet bootstrap and response producer. Keep the existing English state, DOM, dataset, and meta identifiers (`payee-input`, `payee-requirement`, `dataset['counterparty']`, and `payee`) unchanged; only their user-facing Chinese copy and Chinese row/group properties change. Existing deployed sheets are not auto-migrated: setup validation continues to require the new exact header spelling, documented with a one-time manual edit.

**Tech Stack:** TypeScript, Vite, Vitest, jsdom, Node 26, Markdown documentation.

## Global Constraints

- `交易對象` contains `對象` as a substring; replacements must be idempotent and must never create `交易交易對象`.
- Leave `docs/superpowers/specs/` untouched because it is a historical spec snapshot.
- Do not rename `payee-input`, `payee-requirement`, `dataset['counterparty']`, the English `payee` state/field, or the `payee` meta key.
- Update only the requested source, test, deployment, glossary, and ADR files; do not broaden the domain vocabulary.
- Run the full test suite with the installed Node 26 runtime; Node 20 is insufficient because it silently skips `tests/dom.test.ts`.

---

### Task 1: Update schema fixtures and assertions first (RED)

**Files:**
- Modify: `tests/reverse.test.ts`
- Modify: `tests/doPost.test.ts`
- Modify: `tests/headers.test.ts`
- Modify: `tests/migration.test.ts`
- Modify: `tests/pwa-fixtures.ts`
- Modify: `tests/settle.test.ts`
- Modify: `tests/consistency.test.ts`
- Modify: `tests/setup.test.ts`
- Modify: `tests/posting.test.ts`
- Modify: `tests/handler.test.ts`
- Modify: `tests/dom.test.ts`
- Modify: `tests/helpers/gas.ts`

**Interfaces:**
- Consumes: The current legacy `對象` sheet/API fixture contract.
- Produces: Tests and fixtures that require the exact `交易對象` property/header everywhere in the named files, including test descriptions and arbitrary fixture strings that contain the old bare term.

- [ ] **Step 1: Replace the Chinese schema term in test code without double-prefixing.**

  Apply the idempotent mapping `對象 → 交易對象` only where the source text is not already part of `交易對象`. Preserve all English names such as `payee`, `payee-input`, and `dataset['counterparty']` exactly. Header arrays, object keys, TypeScript row types, upstream JSON fixtures, expected values, and test descriptions must all use `交易對象`.

- [ ] **Step 2: Run the changed tests with Node 26 to verify the RED state.**

  Run:

  ```bash
  PATH="/opt/homebrew/opt/node@26/bin:$PATH" npm test -- tests/reverse.test.ts tests/doPost.test.ts tests/headers.test.ts tests/migration.test.ts tests/settle.test.ts tests/consistency.test.ts tests/setup.test.ts tests/posting.test.ts tests/handler.test.ts tests/dom.test.ts
  ```

  Expected: failure because production validators and row accessors still expose the old `對象` header/property; the failure must reference the newly required `交易對象`, not a syntax or test-editing error.

### Task 2: Rename the API schema and runtime validators

**Files:**
- Modify: `src/api.ts:34-53,175,209,223`
- Modify: `apps-script/Code.gs:10,29,242,245,383,386,398,1741,1900,2411`

**Interfaces:**
- Consumes: Task 1's `交易對象` test contract.
- Produces: Three row/group interfaces and three runtime validators whose exact Chinese property is `交易對象`, plus an Apps Script producer/bootstrap whose journal/list headers, option lookup, migration rows, and receivable groups use the same new exact sheet/API property.

- [ ] **Step 1: Rename the three interface fields.**

  Change each `對象: string` interface member in `src/api.ts` to `交易對象: string`; leave the canonical English gloss and all English API/action names unchanged.

- [ ] **Step 2: Rename all three validator property checks.**

  Change each `typeof candidate.對象 === 'string'` check to `typeof candidate.交易對象 === 'string'` at the three runtime validation sites. Do not add a legacy alias or compatibility fallback because this is a breaking schema change.

- [ ] **Step 3: Rename the Apps Script sheet and response producer.**

  Change each bare `對象` header, option-column lookup, journal record value key, receivable group/entry key, carried migration posting key, and posting-row key in `apps-script/Code.gs` to `交易對象`. Preserve `fields.payee` and the English `payee` variable name; they are the input-side English contract, not sheet headers.

- [ ] **Step 4: Run API and schema tests with Node 26.**

  Run:

  ```bash
  PATH="/opt/homebrew/opt/node@26/bin:$PATH" npm test -- tests/api.test.ts tests/headers.test.ts tests/reverse.test.ts tests/doPost.test.ts tests/migration.test.ts tests/settle.test.ts tests/consistency.test.ts tests/setup.test.ts
  ```

  Expected: PASS for the API/schema paths, with no `交易交易對象` occurrence.

### Task 3: Rename PWA row/group accesses and Chinese UI copy

**Files:**
- Modify: `src/main.ts:197-209,415,447,450,684,865,902`

**Interfaces:**
- Consumes: The API row/group contract from Task 2 and the existing English `payee` UI/state identifiers.
- Produces: PWA rendering, grouping, settlement display, confirmation metadata, and labels using `交易對象` while the DOM/state/meta identifiers remain English `payee` names.

- [ ] **Step 1: Rename Chinese row/group property accesses.**

  Change every `row.對象`, `group.對象`, and `entry.對象` access in `src/main.ts` to `.交易對象`. Keep `section.dataset['counterparty']` unchanged.

- [ ] **Step 2: Update only the requested Chinese UI copy.**

  Apply these exact replacements:

  ```text
  對象是誰？       → 交易對象是誰？
  自訂對象         → 自訂交易對象
  輸入其他對象     → 輸入其他交易對象
  未指定對象       → 未指定交易對象
  appendMeta('對象', …) → appendMeta('交易對象', …)
  label: payee || '對象' → label: payee || '交易對象'
  ```

  Do not rename `payee-input`, `payee-requirement`, the `payee` meta key, or any other English identifiers.

- [ ] **Step 3: Run DOM and posting tests with Node 26.**

  Run:

  ```bash
  PATH="/opt/homebrew/opt/node@26/bin:$PATH" npm test -- tests/dom.test.ts tests/posting.test.ts tests/handler.test.ts tests/pwa-fixtures.ts
  ```

  Expected: PASS for UI rendering and posting behavior; `tests/pwa-fixtures.ts` may be reported as a non-test fixture by Vitest but must typecheck in the full build.

### Task 4: Update deployment vocabulary, glossary, and ADR

**Files:**
- Modify: `DEPLOY.md:285-287,422,461`.
- Modify: `CONTEXT.md:31,52-53`.
- Create: `docs/adr/0003-rename-counterparty-header-to-jiaoyiduixiang.md`.

**Interfaces:**
- Consumes: The new exact sheet/API term from Tasks 1–3.
- Produces: Operator instructions, canonical glossary guidance, and an accepted architecture decision that explain the breaking migration and reject the specified alternatives.

- [ ] **Step 1: Update all required deployment header references.**

  Change both required `日記帳` header lists and both `選項清單` header references from `對象` to `交易對象`, preserving header order and all unrelated deployment instructions.

- [ ] **Step 2: Add the troubleshooting migration note.**

  In the troubleshooting area, state that existing deployed spreadsheets require a one-time manual rename of the `日記帳` header cell `對象` and the `選項清單` header cell `對象` to `交易對象`; otherwise setup validation reports the exact error ``missing required header: 交易對象``.

- [ ] **Step 3: Update the glossary and receivable/payable wording.**

  Rename the heading to `交易對象 (Counterparty)`, retain the exact existing definition, change its Avoid line to `_Avoid_: 對象 (legacy header spelling), vendor, payee.`, and replace the receivable/payable phrase so per-counterparty detail lives in each row's `交易對象`.

- [ ] **Step 4: Create ADR 0003 with the required structure and decisions.**

  Use these exact sections: `# ADR 0003: ...`, `## Status` with `Accepted`, `## Context`, `## Decision`, `## Alternatives Considered`, and `## Consequences`. Record the ambiguity of `對象` in Taiwanese Mandarin, the mixed `payee`/`counterparty` glosses, the canonical `交易對象` decision and manual header migration, and reject `對象`, glossary/UI-only renaming, `商家/店家`, and `payee` as the English gloss for the specified reasons.

### Task 5: Full verification and scope audit

**Files:**
- Verify: all modified files above; `docs/superpowers/specs/` must remain unchanged.

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: Fresh Node 26 test/build output and an audit proving no forbidden bare `對象` remains in the requested paths.

- [ ] **Step 1: Run the complete Node 26 test suite.**

  Run:

  ```bash
  PATH="/opt/homebrew/opt/node@26/bin:$PATH" npm test
  ```

  Record the companion stdout verbatim, including the test count and pass/fail result.

- [ ] **Step 2: Run the Node 26 build/typecheck.**

  Run:

  ```bash
  PATH="/opt/homebrew/opt/node@26/bin:$PATH" npm run build
  ```

  Require exit code 0.

- [ ] **Step 3: Audit legacy spellings and preserved English identifiers.**

  Run:

  ```bash
  rg -n --glob '!docs/superpowers/specs/**' '對象' src tests DEPLOY.md CONTEXT.md docs/adr/0003-rename-counterparty-header-to-jiaoyiduixiang.md
  rg -n "payee-input|payee-requirement|dataset\['counterparty'\]|appendMeta\('payee'|\bpayee\b" src/main.ts src/state.ts tests | sed -n '1,240p'
  git diff --check
  git status --short
  ```

  The first scan may show only `交易對象` plus the explicitly documented legacy-spelling mentions in `CONTEXT.md`, `DEPLOY.md`, and ADR 0003; it must show no `交易交易對象`. The second scan must show the English identifiers still present. The diff check must be clean, and no file under `docs/superpowers/specs/` may be modified.
