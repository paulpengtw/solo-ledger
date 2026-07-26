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
  'get_options',
  'create_transaction',
  'list_transactions',
  'list_receivables',
  'settle',
  'reverse_transaction',
  'check_consistency',
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

    nonce = crypto.randomUUID()
    payload = { action: 'check_consistency' }
    if (body.repair === true) {
      payload.repair = true
    }
  } else {
    nonce = crypto.randomUUID()
    payload = { action }
  }

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
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': 'application/json' },
  })
}
