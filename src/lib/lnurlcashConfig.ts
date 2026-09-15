// Wires @lnurlcash/kit's process-wide secret generation to this app's
// active seed (see seed.ts). Must run once, before the package makes any
// request - see its README: "Configuration is process-wide... before any
// requests are made." Imported once for its side effect, from index.tsx.
//
// loadCashRoot() is read fresh on every call rather than captured once, so
// activating or forgetting a seed mid-session (see SeedPanel.tsx) takes
// effect on the very next secret this produces, without needing this module
// to know anything about the app's Solid signals.
import {configureSecretProvider} from '@lnurlcash/kit'
import {bytesToHex} from '@noble/hashes/utils.js'
import {loadCashRoot, nextCk1For} from './seed'

configureSecretProvider(domain => {
  const root = loadCashRoot()
  return root
    ? nextCk1For(root, domain)
    : bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
})
