/**
 * dsh-network — persistent server-client runner (host side).
 *
 * Owns the module-level singleton for the one persistent `dsh-network
 * server` child plus the two thin runners every tool and route uses.
 * Split out of index.js so the entry stays pure wiring; the singleton
 * state must live in exactly one module, so `releaseNetworkClient`
 * (called from the cordis fiber disposer) lives here too.
 */
import { createNetworkServerClient, configToEnv } from './serverClient.js'

// The single persistent `dsh-network server` child. Created lazily on first
// use and bound to the Cordis fiber via ctx.effect(), so it follows dsh's
// lifecycle (started with dsh, killed on dispose). The fiber disposer clears
// this reference, so a reload gets a live client instead of the disposed one.
let networkClient = null

function getNetworkClient() {
  if (!networkClient || networkClient.disposed) networkClient = createNetworkServerClient()
  return networkClient
}

/**
 * Run one job on the persistent loopback server. Returns the entry (the
 * first result of the envelope) and throws with the attempt trail on
 * failure — same contract as the old spawn-per-call runCli, so the tool
 * execute paths below are unchanged apart from the transport.
 */
async function runCli(args, signal, config) {
  const env = configToEnv(config)
  const parsed = await getNetworkClient().invoke(args, env, signal)
  const entry = Array.isArray(parsed.results) ? parsed.results[0] : undefined
  if (!entry || typeof entry.summary !== 'string') {
    throw new Error('dsh-network returned an envelope without a usable source entry')
  }
  if (entry.status === 'unavailable') {
    const attempts = Array.isArray(entry.attempts) ? entry.attempts : []
    const msg = attempts.length
      ? attempts.map((a) => `${a.engine || 'engine'}: ${a.error || 'skipped'}`).join('; ')
      : 'engine chain returned no usable result'
    throw new Error(`dsh-network could not reach the requested source (${msg}). Run \`npx dsh-network doctor\` to check setup.`)
  }
  return entry
}

/**
 * Soft variant used by web_sitemap: an `unavailable` entry is returned as-is
 * instead of throwing — an empty/soft sitemap result is the signal to fall
 * back to web_search, not a hard error.
 */
async function runCliSoft(args, signal, config) {
  const env = configToEnv(config)
  const parsed = await getNetworkClient().invoke(args, env, signal)
  const entry = Array.isArray(parsed.results) ? parsed.results[0] : undefined
  if (!entry || typeof entry.summary !== 'string') {
    throw new Error('dsh-network returned an envelope without a usable source entry')
  }
  return entry
}

/**
 * Drop a disposed client so the next apply() builds a fresh one instead of
 * handing out the corpse. See the fiber disposer in index.js.
 */
function releaseNetworkClient(client) {
  if (networkClient === client) networkClient = null
}

export { getNetworkClient, releaseNetworkClient, runCli, runCliSoft }
