# ADR 0001: GitHub Actions over Cloudflare Pages Git Integration

## Status

Accepted

## Context

Cloudflare Pages offers two mutually exclusive project modes for triggering deployments:

1. **Direct upload** — the project has no connected Git repository; builds and uploads are pushed explicitly by an external caller (e.g. the Wrangler CLI or the Cloudflare API).
2. **Git-connected** — Cloudflare watches a Git repository branch and runs its own build pipeline on every push.

These two modes cannot coexist within a single Pages project; switching between them requires deleting and recreating the project.

This repository already has a GitHub Actions workflow that runs the test suite and build (`npm test`, `npm run build`) before any deployment step. The CI pipeline is the natural home for the deploy step.

## Decision

CI deploys to Cloudflare Pages via GitHub Actions using the direct-upload mode (Wrangler CLI). The Pages project is configured as a direct-upload project with no connected Git repository. All deployment credentials are stored as GitHub Actions secrets.

## Alternatives Considered

### Cloudflare Pages Git Integration (native Git connect)

Cloudflare can watch the repository directly and build on push without any GitHub Actions involvement.

Reasons not chosen:

- **Build environment is less controlled.** Cloudflare's managed build environment may not match the Node version pinned in `engines.node` without additional configuration, making it harder to guarantee that the same Node version runs in CI (`npm test`, `npm run build`) and in the deploy build.
- **Pre-deploy checks are harder to coordinate.** The test suite and build must pass before deployment. With the Git integration, Cloudflare triggers its build independently; there is no built-in way to gate the Pages build on a successful GitHub Actions test run in the same push event.
- **Secrets management is split across two providers.** Deploy-time secrets would need to be maintained in both Cloudflare Pages environment variables and GitHub Actions secrets (for the test workflow), increasing the surface area for drift.
- **The Apps Script deploy step lives in the same workflow.** Clasp pushes to Apps Script from GitHub Actions; keeping both deploy steps in one workflow is simpler than splitting them across two CI systems.

## Consequences

- **Irreversibility of mode choice.** A Cloudflare Pages project cannot be converted between direct-upload and git-connected modes. Reversing this decision means deleting the Pages project and creating a new one, then re-pointing any Cloudflare Access application that covers the old project's hostname at the new project.
- **CI owns the deploy mechanism.** The deployment pipeline is defined in-repo under `.github/workflows/`. Changes to build or deploy steps are version-controlled alongside the application code.
- **Credentials live in GitHub Actions secrets.** `EXPENSE_API_SECRET`, `CLOUDFLARE_API_TOKEN`, and any other deploy-time values are stored as GitHub Actions repository secrets and passed to Wrangler at deploy time. They are not duplicated in Cloudflare's dashboard build settings.
- **Local deploys are possible but manual.** A developer with the appropriate Cloudflare API token can run `wrangler pages deploy` locally using values from a local `.env` file. The `.env` file is never read at runtime by the deployed app.
