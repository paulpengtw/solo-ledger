import { handleAction, type Env } from '../lib/handler'
import { remoteJwks } from '../lib/jwt'

export const onRequestPost: PagesFunction<Env> = ctx =>
  handleAction(String(ctx.params.action), ctx.request, ctx.env, {
    jwks: remoteJwks(ctx.env.CF_ACCESS_TEAM_DOMAIN),
    fetchFn: fetch,
    now: () => Math.floor(Date.now() / 1000),
  })
