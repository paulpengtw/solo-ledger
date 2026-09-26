import type { JWTVerifyGetKey } from 'jose'
import { CONTRACT_VERSION, APP_VERSION } from '../../src/generated/version'
import { buildEnvelope } from './envelope'
import { verifyIdentityJwt } from './jwt'
import type { Env } from './handler'

type Deps = { jwks: JWTVerifyGetKey; fetchFn: typeof fetch; now: () => number }
const unavailable = () => new Response(JSON.stringify({ ok: false, error: '服務暫時無法使用' }), {
  status: 503, headers: { 'content-type': 'application/json' },
})

export async function handleIdentity(request: Request, env: Env, deps: Deps): Promise<Response> {
  if (request.method !== 'GET') return new Response(null, { status: 405 })
  const authorized = await verifyIdentityJwt(request, env.CF_ACCESS_TEAM_DOMAIN,
    env.CF_ACCESS_AUD, deps.jwks, new Date(deps.now() * 1000))
  if (!authorized) return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
    status: 401, headers: { 'content-type': 'application/json' },
  })
  if (!/^[0-9a-f]{40}$/.test(CONTRACT_VERSION) || !/^[0-9a-f]{40}$/.test(APP_VERSION) ||
      !env.EXPENSE_API_URL || !env.EXPENSE_API_SECRET) return unavailable()

  try {
    const envelope = await buildEnvelope(env.EXPENSE_API_SECRET,
      { action: 'integrationState' }, deps.now(), crypto.randomUUID())
    const upstream = await deps.fetchFn(env.EXPENSE_API_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    })
    if (!upstream.ok) return unavailable()
    const state = await upstream.json() as {
      ok?: boolean
      identity?: { contractVersion?: unknown; appVersion?: unknown }
      maintenance?: { kind?: unknown; message?: unknown }
    }
    if (state.ok === false || state.identity?.contractVersion !== CONTRACT_VERSION ||
        typeof state.identity?.appVersion !== 'string' ||
        !/^[0-9a-f]{40}$/.test(state.identity.appVersion) ||
        !state.maintenance ||
        (state.maintenance.kind !== 'open' &&
          !(state.maintenance.kind === 'maintenance' && typeof state.maintenance.message === 'string'))) {
      return unavailable()
    }
    return new Response(JSON.stringify({
      identity: { contractVersion: CONTRACT_VERSION, appVersion: APP_VERSION },
      backendIdentity: state.identity,
      maintenance: state.maintenance,
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  } catch {
    return unavailable()
  }
}
