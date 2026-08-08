# ADR 0004: CI Deploys the Apps Script Backend

## Status

Accepted

## Context

The Pages frontend deploys automatically on every push to `main`
(ADR 0001), but the Apps Script backend was deployed manually with
`clasp push` followed by repointing the versioned `/exec` deployment.
Nothing verified that the deployed backend matched the repository.

On 2026-08-09 this drift broke production: the 對象→交易對象 header
rename (ADR 0003, commit 41b6fec) updated the repository, the PWA, and
the spreadsheet headers, but the manual clasp step never ran. The live
`/exec` deployment kept validating the renamed sheet against the legacy
header list and every `get_options` and `list_transactions` call failed
with `missing required header: 對象`. No test seam can catch this class
of failure, because no test can observe which version the deployed
endpoint is actually running.

## Decision

Pushes to `main` that touch `apps-script/**` deploy the backend from CI.
`.github/workflows/deploy-apps-script.yml` runs `clasp push -f` and then
`clasp deploy -i <deployment-id>` to repoint the existing production
`/exec` deployment, so the URL never changes. It authenticates with the
`CLASPRC_JSON` repository secret, holding the JSON content of a local
`clasp login` credentials file.

The workflow is path-gated rather than run on every push: each
`clasp deploy` mints a new immutable Apps Script version and the
platform caps a project at roughly 200 versions, so frontend-only pushes
must not consume them.

The manual clasp flow in `DEPLOY.md` remains the bootstrap and
emergency path.

## Alternatives Considered

### Keep manual deploys, add a checklist step

Rejected: the failure mode was precisely a forgotten manual step, and a
checklist does not remove the human from the loop.

### Deploy on every push to `main`

Rejected because of the ~200-version cap: most pushes touch only the
PWA and would burn versions without changing the backend.

### A drift-detection check instead of a deploy

Comparing the pushed script content against the repository on each CI
run would detect drift but still require a manual fix. Deploying is the
same amount of automation and removes the drift instead of reporting it.

## Consequences

Backend and frontend can no longer drift silently after a merge to
`main`. A compromised GitHub repository now holds Google credentials
(`CLASPRC_JSON`) that can push arbitrary code to the execute-as-owner
script; the secret is scoped to one repository the operator already
controls, and rotation is a local `clasp login` plus re-upload.
Emergency deploys remain possible with the manual flow.
