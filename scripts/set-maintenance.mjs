import { buildEnvelope } from '../contract/generated/solo-ledger/envelope.ts'
import { CONTRACT_VERSION } from '../src/generated/version.ts'

const mode = process.argv[2]
const url = process.env.EXPENSE_API_URL
const secret = process.env.EXPENSE_API_SECRET
if ((mode !== 'open' && mode !== 'maintenance') || !url || !secret ||
    !/^https:\/\//.test(url)) {
  console.error('maintenance command unavailable: mode or required configuration missing')
  process.exit(1)
}

try {
  const nonce = crypto.randomUUID()
  const commandTs = Date.now()
  const envelope = await buildEnvelope(secret, {
    action: 'setMaintenance', open: mode === 'open', commandTs,
    commandNonce: nonce, contractVersion: CONTRACT_VERSION,
  }, Math.floor(commandTs / 1000), nonce)
  const response = await fetch(url, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope) })
  const body = await response.json()
  if (!response.ok || body?.identity?.contractVersion !== CONTRACT_VERSION ||
      body?.maintenance?.kind !== (mode === 'open' ? 'open' : 'maintenance')) {
    throw new Error('backend did not confirm requested state')
  }
  console.log(`maintenance state confirmed: ${mode}`)
} catch {
  console.error('maintenance command failed; inspect integrationState before retrying')
  process.exitCode = 1
}
