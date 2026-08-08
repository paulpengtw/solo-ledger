# Deploying Solo Ledger

## 1. What this is

Solo Ledger is a mobile PWA that sends structurally validated requests through a Cloudflare Pages Function to an execute-as-owner Apps Script web app, which writes balanced rows into a Google Spreadsheet. Cloudflare Access admits one email, while an HMAC envelope protects the anonymous Apps Script endpoint.

> **ONE-WAY DOOR:** The spreadsheet is the only datastore. There is no second database or event log from which a damaged or deleted journal can be rebuilt; preserve the book, its backups, and the HMAC secret accordingly.

### Terminology

Two distinct artifact types share some vocabulary — context determines which is meant.

| Term | Meaning |
| --- | --- |
| **Apps Script deployment** | A versioned Apps Script artifact identified by its `/exec` URL. "Production" here means the live `/exec` endpoint that receives forwarded requests. |
| **Pages deployment** | A single Cloudflare Pages upload identified by a hash prefix. "Production" here means the Pages production environment (as opposed to a preview deployment). |

> **Disambiguate by context.** Both artifacts use the word "production". When the distinction matters, say "the Apps Script `/exec` endpoint" or "the Pages production environment" rather than just "production".

The HMAC secret (`EXPENSE_API_SECRET`) lives in four distinct configuration homes with different names and purposes:

| Home | Name | Purpose |
| --- | --- | --- |
| Apps Script Script Properties | `EXPENSE_API_SECRET` | Read at runtime by the Apps Script `/exec` endpoint |
| Cloudflare Pages environment variable | `EXPENSE_API_SECRET` | Read at runtime by the Pages Function |
| GitHub Actions secret | `EXPENSE_API_SECRET` | Used by CI to deploy (not read at runtime) |
| Local `.env` | `EXPENSE_API_SECRET` | Local tooling only — **never read at runtime** |

The `.env` file is never loaded by the deployed app; it exists solely for local development scripts.

### Apps Script CI deploy

Pushes to `main` that touch `apps-script/**` trigger `.github/workflows/deploy-apps-script.yml`, which runs `clasp push` and repoints the production `/exec` deployment at the new version. It authenticates with the GitHub Actions secret `CLASPRC_JSON`, holding the full JSON content of a `clasp login` credentials file (`~/.clasprc.json`, clasp 3.x format). Rotate it by re-running `clasp login` locally and re-uploading the file. The manual `clasp push` flow in section 3 remains valid for first-time setup and emergencies.

## 2. Prerequisites

- Node.js 26 or newer (matches `engines.node` in `package.json`) and npm.
- The repository dependencies installed with `npm install`.
- The Apps Script CLI, `clasp`, authenticated to the Google account that will own the deployment.
- A Google account that can create the spreadsheet, own the Apps Script deployment, send the audit email, and create/prune Drive backups.
- A Cloudflare account with Pages and Zero Trust Access.
- `curl`, Python 3, and OpenSSL for the smoke commands below.

Before touching production, run the repository checks:

```sh
npm test
npm run build
```

## 3. First-time deploy

1. **Create the blank spreadsheet and its Apps Script project.**

   Create a blank Google Spreadsheet and copy the spreadsheet ID from the URL between `/d/` and `/edit`. Create a standalone Apps Script project under the same Google account, then copy its **Script ID** from the Apps Script project settings; the code opens both the current and migration-source spreadsheets by ID and does not rely on a bound active spreadsheet.

2. **Set `LEDGER_SPREADSHEET_ID`.**

   In **Apps Script → Project Settings → Script Properties**, add:

   | Property | Value |
   | --- | --- |
   | `LEDGER_SPREADSHEET_ID` | The blank spreadsheet's full ID |
   | `LEDGER_BACKUP_FOLDER_ID` | Optional: an existing Drive folder ID |

   `LEDGER_BACKUP_FOLDER_ID` is the value read through the code constant `BACKUP_FOLDER_PROPERTY`. If it is absent, the first `weeklyBackup()` call creates a new root-level Drive folder named `Solo Ledger backups` and saves its ID into `LEDGER_BACKUP_FOLDER_ID`; it does **not** search for an existing folder of that name. Later calls reuse the saved ID, so the fallback is idempotent after that property write; clearing the property causes another same-named folder to be created.

3. **Configure clasp and push the Apps Script source.**

   At the repository root, create a local `.clasp.json` using the Apps Script **Script ID**, not the spreadsheet ID:

   ```json
   {
     "scriptId": "<APPS_SCRIPT_SCRIPT_ID>",
     "rootDir": "apps-script"
   }
   ```

   Do not commit `.clasp.json`. Authenticate if necessary, then push `apps-script/Code.gs` and `apps-script/appsscript.json`:

   ```sh
   clasp login
   clasp push
   ```

4. **Generate and set `EXPENSE_API_SECRET`.**

   Generate 32 random bytes encoded as 64 hexadecimal characters:

   ```sh
   openssl rand -hex 32
   ```

   Add the output to Apps Script Script Properties as `EXPENSE_API_SECRET`. Keep it out of shell history, commits, screenshots, issues, and chat; when it is later copied to Cloudflare, the two values must be byte-identical, with no added whitespace, or every forwarded request will fail signature verification.

5. **Deploy the Apps Script web app as execute-as-me.**

   In Apps Script, choose **Deploy → New deployment → Web app**, execute as the deploying user (“Me”), and allow anonymous access (“Anyone”). These settings match the manifest values `USER_DEPLOYING` and `ANYONE_ANONYMOUS`: Google authentication is not the web app's guard because the HMAC envelope protects this endpoint and Cloudflare Access protects the Pages app in front of it.

   Save the deployed URL ending in `/exec`; it becomes `EXPENSE_API_URL`. A `/dev` test URL is not the production endpoint.

6. **Run `setupSpreadsheet()` from the Apps Script editor.**

   Select `setupSpreadsheet`, click **Run**, and grant the requested Sheets, Drive, trigger-management, mail-send, and effective-user-email permissions. The function creates or initializes the six tabs, formula tabs, validations, seeds, and text formats described in the smoke checklist; it writes no opening balances.

7. **Enter opening balances by hand.**

   Add one positive `轉帳` row per opening balance directly in `日記帳`, leaving fields not listed below blank:

   | Balance | `借方帳戶` | `貸方帳戶` | Other required values |
   | --- | --- | --- | --- |
   | Asset | The asset account | `期初餘額` | `日期`, positive `金額`, `幣別`, `來源=手動` |
   | Liability | `期初餘額` | The liability account | `日期`, positive `金額`, `幣別`, `來源=手動` |

   Hand rows may leave `txn_id` blank. `期初餘額` is deliberately a `權益` account: `get_options` returns real accounts (`資產`/`負債`) and categories (`收入`/`支出`), so `期初餘額` is intentionally absent from the PWA pickers. Bootstrap opening balances are therefore a manual operation, not a hidden PWA action.

8. **Create/configure the Cloudflare Pages project and its environment.**

   Connect the repository to Pages using the intended production branch. Use:

   - Build command: `npm run build`
   - Build output directory: `dist`
   - Root directory: repository root

   The top-level `functions/api/[action].ts` is the Pages Function. Configure these four production variables and redeploy after setting or changing them:

   | Variable | Exact value |
   | --- | --- |
   | `EXPENSE_API_URL` | The Apps Script web app `/exec` URL |
   | `EXPENSE_API_SECRET` | Byte-identical to the Apps Script property |
   | `CF_ACCESS_TEAM_DOMAIN` | The Access team domain consumed by `https://<domain>/cdn-cgi/access/certs`; store only the domain |
   | `CF_ACCESS_AUD` | The Access application's audience tag |

   The Pages allowlist contains exactly these nine API actions:

   ```text
   health
   auth-check
   get_options
   create_transaction
   list_transactions
   list_receivables
   settle
   reverse_transaction
   check_consistency
   ```

   `auth-check` is Pages-Function-only and returns the verified Access JWT expiry without contacting Apps Script. Apps Script `doPost` routes exactly the other eight actions; no editor-only operation is reachable through it.

9. **Put Cloudflare Access in front of Pages.**

   Create a self-hosted Access application covering every production hostname that serves this Pages project, plus any preview hostname that receives production variables. Enable **One-time PIN** as the login method, create one Allow policy containing the single operator email, and set the application session duration to **1 month**. Copy the application audience tag and team domain into `CF_ACCESS_AUD` and `CF_ACCESS_TEAM_DOMAIN`, redeploy Pages, and verify the gate in the smoke checklist.

10. **Install weekly operations.**

    In the Apps Script editor, run `installWeeklyTriggers()` and grant any remaining permissions. It deletes existing triggers for the same two handlers before creating one `weeklyConsistencyCheck` trigger for Monday at 07:00 and one `weeklyBackup` trigger for Monday at 08:00; `Asia/Taipei` is the script time zone.

    These entry points are intentionally absent from `doPost`: `setupSpreadsheet()`, `installWeeklyTriggers()`, `weeklyConsistencyCheck()`, `weeklyBackup()`, and `closeAndOpenBooks(oldSpreadsheetId)`. Invoke them manually only from the Apps Script editor; after installation, Apps Script itself invokes the two weekly handlers through their triggers.

## 4. Smoke checklist after deploy

1. **Unauthenticated traffic stops at Access.**

   ```sh
   export SOLO_LEDGER_ORIGIN='https://<your-pages-hostname>'
   curl -sS -o /dev/null -w '%{http_code}\n' \
     -X POST "${SOLO_LEDGER_ORIGIN}/api/health"
   ```

   Expected: `302`, redirecting to `https://<team-domain>/cdn-cgi/access/login/...`, before
   the request reaches the Apps Script web app. Cloudflare Access rejects at the edge and
   chooses the form of the rejection from the request headers: a browser-style request such
   as the `curl` above is redirected with `302`, while a request that explicitly identifies
   as XHR is rejected with `401`. Either result proves the same thing — unauthenticated
   traffic never reached Apps Script.

   To assert the `401` form instead:

   ```sh
   curl -sS -o /dev/null -w '%{http_code}\n' \
     -X POST "${SOLO_LEDGER_ORIGIN}/api/health" \
     -H 'content-type: application/json' \
     -H 'x-requested-with: XMLHttpRequest'
   ```

   The Pages Function's own `{ok:false,error:"unauthorized"}` response is defence in depth
   behind Access, so it is observed only by a request that gets past the edge.

2. **Authenticated `health` reaches the correct book.**

   Copy the `CF_Authorization` cookie from an authenticated browser session, then:

   ```bash
   read -rsp 'CF_Authorization cookie: ' CF_AUTHORIZATION
   printf '\n'
   curl --fail-with-body -sS \
     -X POST \
     -H 'content-type: application/json' \
     --cookie "CF_Authorization=${CF_AUTHORIZATION}" \
     --data '{}' \
     "${SOLO_LEDGER_ORIGIN}/api/health"
   unset CF_AUTHORIZATION
   ```

   Expected: JSON with `ok: true`, an ISO `now`, a 12-character hexadecimal `schema_version`, and `spreadsheet_id_tail` matching the tail of `LEDGER_SPREADSHEET_ID` without exposing the full ID.

3. **The checked-in create fixture appends exactly one journal row.**

   The committed `tests/fixtures/create-envelope.json` is a deterministic byte-parity test vector: its timestamp is `1700000000`, its secret is `test-secret`, and its category is `食-外食`, which `setupSpreadsheet()` does not seed. Posting that raw `envelope` cannot pass the live ±300-second timestamp check or a strong production secret.

   First add `食-外食` to `會計科目` as an enabled `支出` row (and copy the corresponding three-cell formula row down in `餘額`). Then, from the repository root, create a temporary live-signed envelope from the fixture's checked-in input and nonce, refreshing only the transport timestamp and signature:

   ```bash
   export EXPENSE_API_URL='https://script.google.com/macros/s/<deployment>/exec'
   read -rsp 'EXPENSE_API_SECRET: ' SOLO_LEDGER_SECRET
   printf '\n'
   export SOLO_LEDGER_SECRET
   export SOLO_LEDGER_SMOKE_ENVELOPE
   SOLO_LEDGER_SMOKE_ENVELOPE="$(mktemp)"

   python3 - <<'PY'
   import base64
   import hashlib
   import hmac
   import json
   import os
   import time

   with open("tests/fixtures/create-envelope.json", encoding="utf-8") as source:
       fixture = json.load(source)

   def b64url(value):
       return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")

   timestamp = int(time.time())
   nonce = fixture["envelope"]["nonce"]
   payload_json = json.dumps(
       fixture["input"],
       ensure_ascii=False,
       separators=(",", ":"),
   )
   payload = b64url(payload_json.encode("utf-8"))
   signing_input = f"{timestamp}.{nonce}.{payload}".encode("utf-8")
   signature = hmac.new(
       os.environ["SOLO_LEDGER_SECRET"].encode("utf-8"),
       signing_input,
       hashlib.sha256,
   ).digest()

   envelope = {
       "ts": timestamp,
       "nonce": nonce,
       "payload": payload,
       "sig": b64url(signature),
   }
   with open(os.environ["SOLO_LEDGER_SMOKE_ENVELOPE"], "w", encoding="utf-8") as target:
       json.dump(envelope, target, ensure_ascii=False, separators=(",", ":"))
   PY

   curl --fail-with-body -sS -L \
     -H 'content-type: application/json' \
     --data-binary "@${SOLO_LEDGER_SMOKE_ENVELOPE}" \
     "${EXPENSE_API_URL}"
   ```

   Expected: `{ "ok": true, ... }` with the fixture `txn_id` `3b241101-e2bb-4255-8caf-4136c566a962`; exactly one new `日記帳` row appears with amount `260`, account `現金`, category `食-外食`, description `午餐`, and `來源=pwa`.

4. **Replaying the exact same envelope is idempotent.**

   Re-run the same `curl` promptly, without regenerating the temporary file:

   ```bash
   curl --fail-with-body -sS -L \
     -H 'content-type: application/json' \
     --data-binary "@${SOLO_LEDGER_SMOKE_ENVELOPE}" \
     "${EXPENSE_API_URL}"

   rm -f "${SOLO_LEDGER_SMOKE_ENVELOPE}"
   unset EXPENSE_API_URL SOLO_LEDGER_SECRET SOLO_LEDGER_SMOKE_ENVELOPE
   ```

   Expected: `ok: true` and `already: true`; no second journal row appears. Reuse must occur while the same envelope timestamp is still within the 300-second window.

5. **The bootstrap matches the spreadsheet contract.**

   Expected:

   - Exactly six tabs: `日記帳`, `會計科目`, `選項清單`, `設定`, `餘額`, `試算與檢查`.
   - The `日記帳` header row contains exactly these 15 required headers, in bootstrap order: `日期`, `時間`, `類型`, `借方帳戶`, `貸方帳戶`, `金額`, `幣別`, `分類`, `交易對象`, `說明`, `結清狀態`, `沖銷txn_id`, `txn_id`, `來源`, `建立時間`.
   - `會計科目` contains the seeded rows `期初餘額`, `應收帳款`, `應付帳款`, `調整支出`, `調整收入`, `現金`, `銀行`, `悠遊卡`, `餐飲`, `交通`, and `薪資收入`, with their code-defined types.
   - `設定` contains `預設幣別=TWD` and `預設帳戶=現金`; `選項清單` begins with the `交易對象` header.
   - `日期`, `時間`, and `建立時間` columns are formatted as plain text (`@`), and the two account columns have advisory validation sourced from `會計科目`.
   - `餘額` and `試算與檢查` contain formulas; `日記帳` contains none.

6. **Google Sheets actually evaluates every `試算與檢查` formula.**

   Test the four rows one at a time, deleting each deliberately corrupt `來源=手動` test row before adding the next:

   - `試算平衡`: add a positive row with a valid debit account but blank credit account. Expected: the result begins `異常：借方總額` and shows unequal totals.
   - `未知帳戶`: add a balanced row using `不存在帳戶` on one leg and `現金` on the other. Expected: `異常：1 個未知帳戶`.
   - `結清狀態與衍生餘額`: add an `應收帳款` debit / `現金` credit row with positive amount, unique `txn_id=smoke-status-1`, and `結清狀態=已結` but no settlement row. Expected: `異常：1 筆結清狀態不一致`.
   - `非文字日期/時間`: for an otherwise balanced row, override that row's `日期` cell to a real Sheets Date value instead of text. Expected: `異常：1 個日期/時間儲存格不是文字`.

   The automated suite proves that these formulas are **constructed** with the expected header-name references, but its fake spreadsheet never **evaluates** them. This destructive-then-cleaned-up manual exercise is the only real proof that Google Sheets evaluates all four formulas correctly; remove every corrupt test row afterward.

7. **The PWA installs from the home screen.**

   On iPhone/iPad, open the production URL in Safari and use **Share → Add to Home Screen**; on a supporting Android browser, use its install action. Expected: the installed app launches in standalone mode as `Solo Ledger 個人記帳`, using the checked-in manifest and icons.

8. **Foregrounding the PWA re-checks Access.**

   With browser network tools open, background the installed PWA and bring it to the foreground. Expected: when `document.visibilityState` becomes `visible`, a fresh `POST /api/auth-check` appears; an expired or invalid session produces the `登入已過期` re-auth prompt.

## 5. Routine operations

### Weekly consistency email

`weeklyConsistencyCheck()` runs a non-repairing audit. It sends mail **only** when `report.clean` is false, to `Session.getEffectiveUser().getEmail()`, with subject `solo-ledger consistency failures` and the full JSON report as the body. No message means only that this run found no failure or did not run; confirm the Apps Script execution/trigger history when delivery is in doubt.

Read each non-clean rule under `rules`: offenses name the journal row and relevant field/value. Fix the underlying hand edit or vocabulary first, then re-run the audit.

### Run `check_consistency` manually

From the developer console of an authenticated production PWA:

```js
fetch('/api/check_consistency', {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({}),
}).then(response => response.json()).then(console.log)
```

Expected for a healthy book: `ok: true`, `clean: true`, `repair_requested: false`, and every rule marked clean.

Repair is explicitly opt-in:

```js
fetch('/api/check_consistency', {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({repair: true}),
}).then(response => response.json()).then(console.log)
```

`repair: true` writes **only** mismatched `結清狀態` cells for status-bearing original rows. It does not change amounts, dates, account legs, categories, IDs, links, other fields, or stray cells. The repair response still reports what it found; run a second non-repairing audit to prove the repaired book is now clean.

### Correct a mistaken settlement

Settlement rows are irreversible through the v1 API. In `日記帳`, identify the mistaken settlement row (`類型=轉帳`, with `沖銷txn_id` pointing to the original), hand-delete that entire settlement row, then call `check_consistency` with `{repair: true}` to recompute the original row's stale `結清狀態` cell. Do not delete the original receivable/payable row, and run the non-repairing audit afterward.

### Backups

`weeklyBackup()` makes a timestamped copy named with prefix `<spreadsheet name> backup ` in the configured folder. The prune pass considers only files in that folder with that exact source-name prefix, keeps the 12 newest (`BACKUP_RETENTION_COUNT`), and moves older matching copies to Drive trash.

If `LEDGER_BACKUP_FOLDER_ID` is set, backups go to that folder. If it is unset, the function creates `Solo Ledger backups` without a name search, stores the new folder ID in that property, and uses it thereafter.

### Service-worker harness

`npm run test:sw` builds the app and drives the real service worker in headless
Chromium: it serves `dist/` from a local origin, registers the worker, then
asserts which requests reach the server, what CacheStorage holds, what a
returning client receives after a simulated redeploy, and that an
authenticated client still opens the app offline. It can also simulate an
unauthenticated origin (Access-style redirect on every navigation), so
session-expiry behaviour is testable without a real Cloudflare Access session.
The command exits non-zero on failure and runs unattended in CI as the
`service-worker` job beside the unit suite — a separate job because it needs a
Chromium download (`npx playwright install --with-deps chromium`) that the
unit tests don't.

### Cloudflare request consumption report

`scripts/cf-consumption-report.mjs` prints a 24-hour view of Pages Function
invocations, drawn from the Cloudflare GraphQL Analytics API.

**Prerequisites — source the environment and add the analytics scope:**

```sh
set -a && . ./.env && set +a
node scripts/cf-consumption-report.mjs
```

`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` must both be set; the script
exits immediately with a named error and the `set -a` hint if either is missing.
The API token needs **Account > Account Analytics > Read** in addition to the
scopes listed in `.env.example`; without it the request returns
`authorization denied` and the script prints a pointed scope hint then exits 1.

**What the report shows:**

- An hourly table: UTC hour, request count, and invocation outcome breakdown.
  The table covers the rolling last 24 hours and may span two UTC calendar days.
- Two totals: rolling 24 h request count, and today-so-far count as a percentage
  of the 100,000 daily free-tier request cap. The cap resets at 00:00 UTC; the
  24 h window may span two billing days, so the cap percentage reflects
  today-so-far only, not the entire window.
- A one-line health verdict:
  - **OK** — total < 500 (expected single-user range).
  - **ELEVATED** — total > 500 but no single hour exceeded 1,000.
  - **WARNING** — any single hour exceeded 1,000 requests (loop signature; the
    2026-07-27 loop burned roughly 40,000 requests/hour).

**Healthy single-user day:**

A normal day consists of a few hundred requests, dominated by `auth-check` at
most 289 times per client per day (one per 5-minute visibility window, per
`src/auth.ts`), plus a handful of `create_transaction`, `list_transactions`, and
other user-initiated actions. Total daily traffic well under 500 is expected for
a single-operator ledger.

**Per-endpoint limitation (pages.dev-only project):**

Because this project owns no Cloudflare zone, no per-URL-path dimension is
available in the GraphQL Analytics API. The report groups by Pages Function
(`scriptName`), invocation outcome, and UTC hour — not by `/api/<action>`. The app has
exactly one function serving `/api/[action]`, so an hourly spike in total
requests IS the loop signal; true per-action breakdown would require the paid
Cloudflare Logs product.

## 6. Changing vocabulary with zero deploys

Edit these tabs directly:

- `會計科目`: real accounts and income/expense categories, including name, type, subtype, enabled flag, and sort order.
- `選項清單`: suggested `交易對象` values.
- `設定`: `預設幣別` and `預設帳戶`.

`schema_version` is recalculated from the displayed used-range values of those three tabs. A change is returned by both `health` and `get_options`; if it changes mid-session, the PWA displays a soft warning banner and remains usable.

The current bootstrap installs one `餘額` formula row per account present when `setupSpreadsheet()` first initializes the blank tab. When appending a new `會計科目` row later, copy the corresponding three formula cells down in `餘額` as another sheet-only edit; rerunning `setupSpreadsheet()` does not extend an already-populated formula tab.

Adding or changing a vocabulary **value** needs no code or deployment. Adding a new form **field** still changes the static PWA form, Pages validation, Apps Script contract, and tests, so it requires a code change and deploy.

## 7. Migration to a fresh book

### Path A — close the old book and open a fresh one

1. Record the old spreadsheet ID, create a blank new spreadsheet, and record its ID. Do not add journal rows to the new book.
2. In the existing Apps Script project's Script Properties, re-point `LEDGER_SPREADSHEET_ID` to the **new** spreadsheet ID. This is the temporary re-point needed while initializing and migrating; after success, it becomes the permanent production value.
3. Run `setupSpreadsheet()` from the editor against the new ID.
4. Re-create any custom accounts by hand in the new book's `會計科目`. `setupSpreadsheet()` seeds only the system accounts (`期初餘額`, `應收帳款`, `應付帳款`, `調整支出`, `調整收入`) plus starter accounts — it does not know about accounts you added yourself, such as a named credit card. `closeAndOpenBooks()` does **not** copy the chart of accounts, so an account present only in the old book will fail vocabulary validation with `unknown or disabled account: <name>` and no rows will be written. Copy the `名稱`, `類型`, `子類型`, `啟用` and `排序` values across as they were, preserving `啟用=FALSE` on any account you had deliberately disabled.
5. Run `closeAndOpenBooks('<old-spreadsheet-id>')` from the editor. The IDs must differ and the new `日記帳` must still have only its header.
6. Review the result counts (`opening_rows`, `carried_rows`, and total `rows`).
7. Leave `LEDGER_SPREADSHEET_ID` on the new ID, then update any operator records that identify the current book.

The migration writes per-account asset/liability opening rows against `期初餘額` with `來源=移轉`. Open `應收`/`應付` items carry across at their **REMAINING OUTSTANDING**, with fresh `txn_id` values, `來源=移轉`, `結清狀態=未結`, and `承前-` prefixed to the original `說明`. Linked settlement history stays in the old book by design, and the old spreadsheet is read-only to this operation and left untouched.

### Path B — retain the full history

1. In Google Sheets, use **File → Make a copy** on the old book.
2. Point `LEDGER_SPREADSHEET_ID` at the copy's spreadsheet ID.
3. Keep the deployed Apps Script URL and Cloudflare variables unchanged unless the Apps Script deployment itself was also replaced.

Path B preserves the copied journal history rather than synthesizing opening rows.

### Verify either path

Run `check_consistency` without repair and require `clean: true`. Then call `health` and require `spreadsheet_id_tail` to match the **new** `LEDGER_SPREADSHEET_ID`; do not resume normal entry until both checks pass.

## 8. Troubleshooting

- **`bad signature`**: `EXPENSE_API_SECRET` differs between Cloudflare and Apps Script, including encoding or whitespace. Replace one side with a byte-identical copy and redeploy Pages after changing its environment.
- **`request timestamp outside allowed window`**: the envelope timestamp differs from Apps Script time by more than `MAX_SKEW_SECONDS=300`. Correct the sending system's clock and sign a fresh envelope; this is a distinct error from `bad signature`.
- **Counterparty header migration**: existing deployed spreadsheets must have the `日記帳` header cell `對象` and the `選項清單` header cell `對象` hand-renamed to `交易對象` before setup validation. Otherwise setup validation reports `missing required header: 交易對象`.
- **`missing required header: <name>`**: restore the exact reported header spelling. The 15 journal names are `日期`, `時間`, `類型`, `借方帳戶`, `貸方帳戶`, `金額`, `幣別`, `分類`, `交易對象`, `說明`, `結清狀態`, `沖銷txn_id`, `txn_id`, `來源`, and `建立時間`; for example, `missing required header: txn_id` means the exact `txn_id` cell is absent or renamed.
- **`unknown or disabled account: <name>`** (or category): vocabulary lives in `會計科目`, not code. Correct the journal value or add/enable the exact account/category there; do not patch a TypeScript option list.
- **302 to the Access login, or 401 from `/api/*`**: both mean the request was not authenticated, and Access chooses between them by request headers — a browser-style request is redirected with `302`, one identifying as XHR is rejected with `401`. First confirm the email is the sole allowed Access policy member and complete the one-time-PIN login. If login succeeded, verify `CF_ACCESS_AUD` and `CF_ACCESS_TEAM_DOMAIN`, then redeploy after any environment change; behind Access, the Pages Function independently rejects a missing, expired, wrong-audience, or unverifiable `CF_Authorization` cookie with `{ok:false,error:"unauthorized"}`.
- **`over-settlement: amount <amount> exceeds outstanding <outstanding>`**: do not retry the same amount. Refresh the outstanding list and settle no more than the remaining amount.
- **`original currency <currency> differs from default <default>`** during settle: v1 stamps settlement currency from `設定` → `預設幣別` and accepts no currency override. Foreign-currency settlement must be handled by hand, or the book's default must genuinely be corrected before retrying; sending `currency` is rejected as `currency is not accepted`.
- **Cloudflare serves its daily-limit error page on `/api/*` (the PWA shell may still load; every function route fails platform-wide)**: the free tier's 100,000 requests/day Functions cap is exhausted. The cap resets automatically at 00:00 UTC; no operator action is required to restore service after the reset. To identify a runaway client before then, run `node scripts/cf-consumption-report.mjs` — any hour showing more than 1,000 requests is a loop signature (see ADR 0002 for the scheduling constraint that prevents this). Do not delete the Pages project to stop the bleeding: that was the 2026-07-27 remedy and forced a full rebuild of the project and all its environment variables (ADR 0001 explains why recreation is expensive). Prefer waiting out the reset or disabling the offending client.

## 9. Operating rules

- **Never sort `日記帳` in place.** Use filter views so physical row order and row-addressed operations remain stable.
- `日記帳` holds no formulas. Keep formulas in `餘額` and `試算與檢查`.
- Every hand-entered journal row must set `來源=手動`.
