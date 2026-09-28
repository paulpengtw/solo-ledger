import { CONTRACT_VERSION, APP_VERSION } from '../../src/generated/version'
import type { JWTVerifyGetKey } from 'jose'
import { buildEnvelope } from './envelope'
import { verifyAccessJwt } from './jwt'
import {
  isValidUuid,
  validateReversal,
  validateSettlement,
  validateTransaction,
  validateTransactionDateRange,
} from './validate'

export type Env = {
  EXPENSE_API_URL: string
  EXPENSE_API_SECRET: string
  CF_ACCESS_TEAM_DOMAIN: string
  CF_ACCESS_AUD: string
}

type Deps = {
  jwks: JWTVerifyGetKey
  fetchFn: typeof fetch
  now: () => number
}

const ALLOWED = new Set([
  'health',
  'auth-check',
  'integrationState',
  'enable_e2',
  'enable_integration_schema',
  'snapshot',
  'lookup',
  'adopt_identity',
  'command',
  'outcome',
  'create_event_group',
  'event_group',
  'confirm_event',
  'review_event',
  'accept_import',
  'import_manifest',
  'resume_import',
  'record_evidence',
  'source_evidence',
  'record_link',
  'link_record',
  'accept_checkpoint',
  'checkpoint',
  'set_versioned_setting',
  'publish_result',
  'opening_adjustment',
  'cutover_adjustment',
  'correct_event',
  'append_correction',
  'get_options',
  'create_transaction',
  'list_transactions',
  'list_receivables',
  'settle',
  'reverse_transaction',
  'check_consistency',
])

const E2_WRITE_ACTIONS = new Set([
  'command', 'adopt_identity',
  'create_event_group', 'event_group', 'confirm_event', 'review_event',
  'accept_import', 'import_manifest', 'resume_import', 'record_evidence',
  'source_evidence', 'record_link', 'link_record', 'accept_checkpoint',
  'checkpoint', 'set_versioned_setting', 'publish_result',
  'opening_adjustment', 'cutover_adjustment', 'correct_event',
  'append_correction',
])

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export async function handleAction(
  action: string,
  request: Request,
  env: Env,
  deps: Deps,
): Promise<Response> {
  const auth = await verifyAccessJwt(
    request.headers.get('cookie'),
    env.CF_ACCESS_AUD,
    deps.jwks,
    new Date(deps.now() * 1000),
  )
  if (!auth.ok) {
    return json(401, { ok: false, error: 'unauthorized' })
  }
  if (!ALLOWED.has(action)) {
    return json(403, { ok: false, error: 'forbidden action' })
  }
  if (action === 'auth-check') {
    return json(200, { ok: true, exp: auth.exp })
  }

  if (action !== 'auth-check' && (!/^[0-9a-f]{40}$/.test(APP_VERSION) ||
      request.headers.get('x-contract-version') !== CONTRACT_VERSION)) {
    return json(409, { ok: false, error: '版本已更新，請重新整理頁面' })
  }

  let payload: Record<string, unknown>
  let nonce: string

  if (action === 'create_transaction') {
    let body: Record<string, unknown> = {}
    try {
      const parsed = await request.json()
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>
      }
    } catch {
      // Invalid JSON is handled as an invalid transaction below.
    }

    const validated = validateTransaction(body.transaction)
    if (!validated.ok) {
      return json(400, { ok: false, error: validated.error })
    }
    if (!isValidUuid(body.idempotencyKey)) {
      return json(400, { ok: false, error: 'invalid idempotency key' })
    }

    nonce = body.idempotencyKey
    payload = {
      action: 'create_transaction',
      idempotencyKey: body.idempotencyKey,
      transaction: validated.transaction,
    }
  } else if (action === 'settle') {
    let body: Record<string, unknown> = {}
    try {
      const parsed = await request.json()
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>
      }
    } catch {
      // Invalid JSON is handled as an invalid settlement below.
    }

    const validated = validateSettlement(body)
    if (!validated.ok) {
      return json(400, { ok: false, error: validated.error })
    }
    if (!isValidUuid(body.idempotencyKey)) {
      return json(400, { ok: false, error: 'invalid idempotency key' })
    }

    nonce = body.idempotencyKey
    payload = {
      action: 'settle',
      idempotencyKey: body.idempotencyKey,
      ...validated.settlement,
    }
  } else if (action === 'reverse_transaction') {
    let body: Record<string, unknown> = {}
    try {
      const parsed = await request.json()
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>
      }
    } catch {
      // Invalid JSON is handled as an invalid reversal below.
    }

    const validated = validateReversal(body)
    if (!validated.ok) {
      return json(400, { ok: false, error: validated.error })
    }
    if (!isValidUuid(body.idempotencyKey)) {
      return json(400, { ok: false, error: 'invalid idempotency key' })
    }

    nonce = body.idempotencyKey
    payload = {
      action: 'reverse_transaction',
      idempotencyKey: body.idempotencyKey,
      ...validated.reversal,
    }
  } else if (action === 'list_transactions') {
    let body: Record<string, unknown> = {}
    try {
      const parsed = await request.json()
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>
      }
    } catch {
      // Invalid JSON is handled as an invalid date range below.
    }

    const validated = validateTransactionDateRange(body)
    if (!validated.ok) {
      return json(400, { ok: false, error: validated.error })
    }

    nonce = crypto.randomUUID()
    payload = {
      action: 'list_transactions',
      date_from: validated.date_from,
      date_to: validated.date_to,
    }
  } else if (action === 'check_consistency') {
    let body: Record<string, unknown> = {}
    try {
      const parsed = await request.json()
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>
      } else {
        return json(400, { ok: false, error: 'invalid request body' })
      }
    } catch {
      return json(400, { ok: false, error: 'invalid request body' })
    }

    if (
      Object.prototype.hasOwnProperty.call(body, 'repair')
      && typeof body.repair !== 'boolean'
    ) {
      return json(400, { ok: false, error: 'invalid repair flag' })
    }

    payload = { action: 'check_consistency' }
    if (body.repair === true) {
      if (!isValidUuid(body.idempotencyKey)) {
        return json(400, { ok: false, error: 'invalid idempotency key' })
      }
      nonce = body.idempotencyKey
      payload.repair = true
      payload.idempotencyKey = body.idempotencyKey
    } else {
      nonce = crypto.randomUUID()
    }
  } else if (action === 'snapshot') {
    let body: Record<string, unknown> = {}
    try {
      const parsed = await request.json()
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
    } catch {
      return json(400, { ok: false, error: 'invalid request body' })
    }
    const scope = body.scope
    const scopes = new Set([
      'accounts', 'events', 'observations', 'groups', 'event-groups', 'operations', 'claims',
      'manifests', 'steps', 'evidence', 'links', 'checkpoints', 'settings', 'results', 'records',
    ])
    if (typeof scope !== 'string' || !scopes.has(scope)) return json(400, { ok: false, error: 'invalid snapshot scope' })
    if (body.cursor !== undefined && typeof body.cursor !== 'string') return json(400, { ok: false, error: 'invalid snapshot cursor' })
    if (body.snapshotRevision !== undefined && typeof body.snapshotRevision !== 'string') return json(400, { ok: false, error: 'invalid snapshot revision' })
    if (body.cursor !== undefined && body.snapshotRevision === undefined) return json(400, { ok: false, error: 'snapshot continuation requires snapshotRevision' })
    if (body.interval !== undefined) {
      if (typeof body.interval !== 'object' || body.interval === null || Array.isArray(body.interval)) return json(400, { ok: false, error: 'invalid snapshot interval' })
      const interval = body.interval as Record<string, unknown>
      if (typeof interval.from !== 'string' || typeof interval.to !== 'string') return json(400, { ok: false, error: 'invalid snapshot interval' })
    }
    nonce = crypto.randomUUID()
    payload = { action: 'snapshot', scope, ...(body.cursor === undefined ? {} : { cursor: body.cursor }), ...(body.snapshotRevision === undefined ? {} : { snapshotRevision: body.snapshotRevision }), ...(body.interval === undefined ? {} : { interval: body.interval }) }
  } else if (action === 'lookup') {
    let body: Record<string, unknown> = {}
    try {
      const parsed = await request.json()
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return json(400, { ok: false, error: 'invalid request body' })
      body = parsed as Record<string, unknown>
    } catch {
      return json(400, { ok: false, error: 'invalid request body' })
    }
    if (!Array.isArray(body.ids) || body.ids.some(id => typeof id !== 'string' || id.trim() === '')) return json(400, { ok: false, error: 'invalid lookup ids' })
    if (typeof body.snapshotRevision !== 'string' || body.snapshotRevision === '') return json(400, { ok: false, error: 'lookup requires snapshotRevision' })
    nonce = crypto.randomUUID()
    payload = { action: 'lookup', ids: body.ids, snapshotRevision: body.snapshotRevision }
  } else if (action === 'adopt_identity' || action === 'command' || action === 'outcome' || [
    'create_event_group', 'event_group', 'confirm_event', 'review_event',
    'accept_import', 'import_manifest', 'resume_import', 'record_evidence',
    'source_evidence', 'record_link', 'link_record', 'accept_checkpoint',
    'checkpoint', 'set_versioned_setting', 'publish_result',
    'opening_adjustment', 'cutover_adjustment', 'correct_event',
    'append_correction',
  ].includes(action)) {
    let body: Record<string, unknown> = {}
    try {
      const parsed = await request.json()
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return json(400, { ok: false, error: 'invalid request body' })
      body = parsed as Record<string, unknown>
    } catch {
      return json(400, { ok: false, error: 'invalid request body' })
    }
    if (action === 'command') {
      if (typeof body.operationId !== 'string' || body.operationId.trim() === '') return json(400, { ok: false, error: 'operationId is required' })
      if (!Array.isArray(body.expectedRevisions)) return json(400, { ok: false, error: 'expectedRevisions must be an array' })
      if (typeof body.contentDigest !== 'string' || body.contentDigest.trim() === '') return json(400, { ok: false, error: 'contentDigest is required' })
      if (typeof body.content !== 'object' || body.content === null || Array.isArray(body.content)) return json(400, { ok: false, error: 'content is required' })
    } else if (action === 'outcome') {
      if (typeof body.operationId !== 'string' || body.operationId.trim() === '') return json(400, { ok: false, error: 'operationId is required' })
    } else {
      if (typeof body.operationId !== 'string' || body.operationId.trim() === '') return json(400, { ok: false, error: 'operationId is required' })
    }
    nonce = crypto.randomUUID()
    if (E2_WRITE_ACTIONS.has(action)) {
      // Never persist an actor supplied by the browser.  GAS receives the
      // verified Pages Access principal (or the deterministic fixture
      // fallback) on both the envelope and command content.
      body.actor = auth.actor
      if (action === 'command' && typeof body.content === 'object' && body.content !== null && !Array.isArray(body.content)) {
        body.content = { ...(body.content as Record<string, unknown>), actor: auth.actor }
      }
    }
    payload = { action, ...body }
  } else {
    nonce = crypto.randomUUID()
    payload = { action }
  }

  payload.contractVersion = CONTRACT_VERSION
  const envelope = await buildEnvelope(
    env.EXPENSE_API_SECRET,
    payload,
    deps.now(),
    nonce,
  )
  const upstream = await deps.fetchFn(env.EXPENSE_API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  })
  const upstreamText = await upstream.text()
  let upstreamResult: { error?: string } = {}
  try { upstreamResult = JSON.parse(upstreamText) as { error?: string } } catch { /* preserve upstream response */ }
  const status = upstreamResult.error === '系統更新中' ? 503
    : upstreamResult.error === '版本已更新，請重新整理頁面' ? 409
    : upstream.status
  return new Response(upstreamText, {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
