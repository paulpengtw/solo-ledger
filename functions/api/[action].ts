import { handleAction, type Env } from '../lib/handler'
import { remoteJwks } from '../lib/jwt'

export const onRequestPost: PagesFunction<Env> = ctx =>
  handleAction(String(ctx.params.action), ctx.request, ctx.env, {
    jwks: remoteJwks(ctx.env.CF_ACCESS_TEAM_DOMAIN),
    // A bare `fetch` reference invoked as `deps.fetchFn(...)` gets `deps` as its
    // `this`, which workerd rejects with "Illegal invocation"; wrap it so the
    // call is a plain global invocation.
    fetchFn: (input, init) => fetch(input, init),
    now: () => Math.floor(Date.now() / 1000),
  })
