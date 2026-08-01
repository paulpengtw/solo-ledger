import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflowPath = fileURLToPath(
  new URL('../../.github/workflows/ci.yml', import.meta.url),
)
const rawText = (() => {
  try {
    return readFileSync(workflowPath, 'utf-8')
  } catch {
    return ''
  }
})()
const doc: any = rawText ? parse(rawText) : null

describe('.github/workflows/ci.yml', () => {
  it('triggers on pull_request and on push to main only', () => {
    expect(doc.on).toHaveProperty('pull_request')
    expect(doc.on.push.branches).toEqual(['main'])
  })

  it('pins Node 26 and the exact command sequence of every job', () => {
    for (const job of Object.values(doc.jobs) as any[]) {
      const setupNodeStep = (job.steps as any[]).find(
        (step: any) =>
          typeof step.uses === 'string' &&
          step.uses.startsWith('actions/setup-node@'),
      )
      expect(setupNodeStep).toBeDefined()
      expect(setupNodeStep.with['node-version']).toBe('26')
    }

    const runsOf = (name: string): string[] =>
      (doc.jobs[name].steps as any[])
        .filter((step: any) => typeof step.run === 'string')
        .map((step: any) => (step.run as string).trim())

    expect(Object.keys(doc.jobs)).toEqual(['build', 'service-worker'])
    expect(runsOf('build')).toEqual(['npm ci', 'npm test', 'npm run build'])
    expect(runsOf('service-worker')).toEqual([
      'npm ci',
      'npx playwright install --with-deps chromium',
      'npm run test:sw',
    ])
  })

  it('cancels in-progress runs for pull requests but not for pushes to main', () => {
    const cancelInProgress = String(doc.concurrency['cancel-in-progress'])
    expect(cancelInProgress).toContain('github.event_name')
    expect(cancelInProgress).toContain('pull_request')

    const group = String(doc.concurrency.group)
    expect(
      group.includes('github.ref') || group.includes('github.head_ref'),
    ).toBe(true)
  })

  it('grants only contents: read at the top-level permissions', () => {
    expect(doc.permissions).toEqual({ contents: 'read' })
  })

  it('uses only actions/checkout and actions/setup-node across all jobs', () => {
    const jobs = Object.values(doc.jobs) as any[]
    const allUses = jobs
      .flatMap((job: any) => job.steps as any[])
      .map((step: any) => step.uses)
      .filter((uses: unknown) => typeof uses === 'string') as string[]

    for (const uses of allUses) {
      expect(
        uses.startsWith('actions/checkout@') ||
          uses.startsWith('actions/setup-node@'),
      ).toBe(true)
    }
  })

  it('contains no Cloudflare deploy — no wrangler, cloudflare, or pages deploy references', () => {
    expect(rawText).not.toBe('')
    expect(rawText).not.toMatch(/cloudflare/i)
    expect(rawText).not.toMatch(/wrangler/i)
    expect(rawText).not.toMatch(/pages deploy/i)

    const jobs = Object.values(doc.jobs) as any[]
    const runCommands = jobs
      .flatMap((job: any) => job.steps as any[])
      .filter((step: any) => typeof step.run === 'string')
      .map((step: any) => step.run as string)

    for (const run of runCommands) {
      expect(run).not.toMatch(/wrangler/)
    }
  })
})
