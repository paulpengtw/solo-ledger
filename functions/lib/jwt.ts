import { jwtVerify, createRemoteJWKSet, type JWTVerifyGetKey } from 'jose'

export type JwtResult = { ok: true; exp: number; actor: string } | { ok: false }

const jwksCache = new Map<string, JWTVerifyGetKey>()

export function remoteJwks(teamDomain: string): JWTVerifyGetKey {
  let jwks = jwksCache.get(teamDomain)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`))
    jwksCache.set(teamDomain, jwks)
  }
  return jwks
}

function extractToken(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === 'CF_Authorization') return rest.join('=')
  }
  return null
}

export async function verifyAccessJwt(
  cookieHeader: string | null, aud: string, jwks: JWTVerifyGetKey,
  currentDate?: Date,
): Promise<JwtResult> {
  const token = extractToken(cookieHeader)
  if (!token) return { ok: false }
  try {
    const { payload } = await jwtVerify(token, jwks, { audience: aud, ...(currentDate ? { currentDate } : {}) })
    if (typeof payload.exp !== 'number' || payload.sub === '' ||
        typeof payload.common_name === 'string') return { ok: false }
    const subject = typeof payload.sub === 'string' ? payload.sub.trim() : ''
    const email = typeof payload.email === 'string' ? payload.email.trim() : ''
    // Existing local/fixture Access tokens omit identity claims.  Keep their
    // deterministic fallback while deriving real writes from verified claims
    // whenever Access provides them.
    const actor = subject || email || `access-exp:${payload.exp}`
    return { ok: true, exp: payload.exp, actor }
  } catch {
    return { ok: false }
  }
}


export async function verifyIdentityJwt(
  request: Request, teamDomain: string, aud: string, jwks: JWTVerifyGetKey,
  currentDate?: Date,
): Promise<boolean> {
  const token = request.headers.get('cf-access-jwt-assertion') ?? extractToken(request.headers.get('cookie'))
  if (!token || !teamDomain || !aud) return false
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `https://${teamDomain}`, audience: aud,
      ...(currentDate ? { currentDate } : {}),
    })
    if (payload.type !== 'app' || typeof payload.exp !== 'number') return false
    const human = typeof payload.sub === 'string' && payload.sub !== ''
      && typeof payload.email === 'string' && payload.email !== ''
    const service = payload.sub === '' && typeof payload.common_name === 'string'
      && payload.common_name.trim() !== ''
    return human || service
  } catch {
    return false
  }
}
