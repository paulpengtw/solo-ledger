function b64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function buildEnvelope(
  secret: string,
  payload: unknown,
  ts: number,
  nonce: string,
): Promise<{ ts: number; nonce: string; payload: string; sig: string }> {
  const payloadB64 = b64url(new TextEncoder().encode(JSON.stringify(payload)))
  const signingInput = new TextEncoder().encode(`${ts}.${nonce}.${payloadB64}`)
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const sig = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, signingInput)))
  return { ts, nonce, payload: payloadB64, sig }
}
