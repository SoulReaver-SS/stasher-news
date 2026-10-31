// Onion-Location: tells Tor Browser that this page is also available as an
// onion service, so it can offer to switch. Off until the operator sets
// ONION_URL (e.g. http://<56 base32 chars>.onion) after publishing the
// service (docs/ops/onion-service.md).
const V3_ONION = /^http:\/\/[a-z2-7]{56}\.onion\/?$/

export function onionLocationFor ({ onionUrl, host, mainUrl, pathname = '/', search = '' }) {
  if (!onionUrl || !V3_ONION.test(onionUrl) || !host || !mainUrl) return null
  let mainHost
  try { mainHost = new URL(mainUrl).host } catch { return null }
  // only the main site: never on custom domains or on the onion itself
  if (host.toLowerCase() !== mainHost.toLowerCase()) return null
  return onionUrl.replace(/\/$/, '') + pathname + search
}
