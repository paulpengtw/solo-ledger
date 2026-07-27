import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflowPath = fileURLToPath(
  new URL('../../.github/workflows/deploy.yml', import.meta.url),
)
const rawText = (() => {
  try {
    return readFileSync(workflowPath, 'utf-8')
  } catch {
    return ''
  }
})()
const doc: any = rawText ? parse(rawText) : null

describe('.github/workflows/deploy.yml', () => {
  it('triggers on push to main and workflow_dispatch but not pull_request', () => {
    expect(doc).not.toBeNull()
    expect(doc.on.push.branches).toEqual(['main'])
    expect(doc.on).toHaveProperty('workflow_dispatch')
    expect(doc.on).not.toHaveProperty('pull_request')
  })

  it('queues main runs with cancel-in-progress false and a group that does not use head_ref', () => {
    const cancelInProgress = String(doc.concurrency['cancel-in-progress'])
    expect(cancelInProgress).toBe('false')
    const group = String(doc.concurrency.group)
    expect(group).not.toContain('head_ref')
  })

  it('uses only actions/checkout and actions/setup-node with node 26', () => {
    const jobs = Object.values(doc.jobs) as any[]
    const allSteps = jobs.flatMap((job: any) => job.steps as any[])
    const usesSteps = allSteps.filter((step: any) => typeof step.uses === 'string')
    for (const step of usesSteps) {
      expect(
        step.uses.startsWith('actions/checkout@') ||
          step.uses.startsWith('actions/setup-node@'),
      ).toBe(true)
    }
    const setupNodeStep = allSteps.find(
      (step: any) =>
        typeof step.uses === 'string' &&
        step.uses.startsWith('actions/setup-node@'),
    )
    expect(setupNodeStep).toBeDefined()
    expect(setupNodeStep.with['node-version']).toBe('26')
  })

  it('deploys with npx wrangler via npm ci then npm run build then wrangler deploy with CF secrets', () => {
    const jobs = Object.values(doc.jobs) as any[]
    const allSteps = jobs.flatMap((job: any) => job.steps as any[])
    const runSteps = allSteps.filter((step: any) => typeof step.run === 'string')
    const runTexts = runSteps.map((step: any) => (step.run as string).trim())

    const npmCiIdx = runTexts.findIndex((r: string) => r === 'npm ci')
    const buildIdx = runTexts.findIndex((r: string) => r === 'npm run build')
    const wranglerIdx = runTexts.findIndex((r: string) =>
      r.startsWith('npx wrangler pages deploy dist'),
    )

    expect(npmCiIdx).toBeGreaterThanOrEqual(0)
    expect(buildIdx).toBeGreaterThan(npmCiIdx)
    expect(wranglerIdx).toBeGreaterThan(buildIdx)

    const wranglerStep = runSteps[wranglerIdx]
    expect(wranglerStep.run).toContain('--project-name=solo-ledger')

    expect(wranglerStep.env).toMatchObject({
      CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}',
      CLOUDFLARE_ACCOUNT_ID: '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
    })
  })

  it('asserts access gate after deploy: 302 for plain POST and 401 for XHR POST to /api/health', () => {
    const jobs = Object.values(doc.jobs) as any[]
    const allSteps = jobs.flatMap((job: any) => job.steps as any[])
    const runSteps = allSteps.filter((step: any) => typeof step.run === 'string')

    const wranglerIdx = runSteps.findIndex((step: any) =>
      (step.run as string).startsWith('npx wrangler pages deploy dist'),
    )

    const gateStep = runSteps
      .slice(wranglerIdx + 1)
      .find(
        (step: any) =>
          (step.run as string).includes('/api/health') &&
          (step.run as string).includes('x-requested-with: XMLHttpRequest'),
      )

    expect(gateStep).toBeDefined()
    const gateRun = gateStep.run as string
    expect(gateRun).toContain('302')
    expect(gateRun).toContain('401')
    expect(gateRun).toContain('https://solo-ledger.pages.dev')
  })

  it('grants only contents: read at the top-level permissions', () => {
    expect(doc.permissions).toEqual({ contents: 'read' })
  })

  it('contains no mutations to Pages env vars or Cloudflare Access configuration', () => {
    const lower = rawText.toLowerCase()
    expect(lower).not.toMatch(/wrangler pages secret/)
    expect(lower).not.toMatch(/wrangler pages project/)
    expect(lower).not.toMatch(/wrangler pages env/)
    expect(lower).not.toMatch(/cloudflare access/)
    expect(lower).not.toMatch(/access application/)
    expect(lower).not.toMatch(/access policy/)
  })
})
