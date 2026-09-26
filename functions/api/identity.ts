import { handleIdentity } from '../lib/identity'
import type { Env } from '../lib/handler'
import { remoteJwks } from '../lib/jwt'

export const onRequestGet: PagesFunction<Env> = ctx =>
  handleIdentity(ctx.request, ctx.env, {
    jwks: remoteJwks(ctx.env.CF_ACCESS_TEAM_DOMAIN),
    fetchFn: (input, init) => fetch(input, init),
    now: () => Math.floor(Date.now() / 1000),
  })
