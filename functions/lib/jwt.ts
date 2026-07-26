import { jwtVerify, createRemoteJWKSet, type JWTVerifyGetKey } from 'jose'

export type JwtResult = { ok: true; exp: number } | { ok: false }

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
    if (typeof payload.exp !== 'number') return { ok: false }
    return { ok: true, exp: payload.exp }
  } catch {
    return { ok: false }
  }
}
