// Seed-recoverable ticket secrets (LUD-25 Part 2). Generating or restoring a
// 12-word BIP39 phrase here means every ticket a run mints can be
// re-derived later from the phrase alone - a lost PersistedRun record (see
// storage.ts) is a print-job to redo, not money gone; see recovery.ts for
// the scan that finds already-minted notes back from a phrase.
//
// The phrase itself is NEVER persisted - only the BIP39 seed derived from
// it, as hex, in localStorage. That's still bearer material for every note
// this browser will ever mint under it: anyone who reads it can derive
// every secret this app produces at every mint. Treat this device/browser
// storage with the same care as the notes themselves.
//
// @lnurlcash/kit only derives per-index note keys from a caller-supplied
// per-host branch (deriveNoteSecretKey/deriveNotePubkey) - it deliberately
// does not derive that branch from a seed itself ("wallet policy", per its
// own migration notes). branchFor below is that missing hop: one HKDF call
// per (seed, host), domain-separated by host the same way a per-host cash
// derivation always has to be, so no two mints ever share secrets under the
// same seed.
import {
  generateMnemonic,
  mnemonicToSeedSync,
  validateMnemonic
} from '@scure/bip39'
import {wordlist} from '@scure/bip39/wordlists/english.js'
import {hkdf} from '@noble/hashes/hkdf.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {schnorr} from '@noble/curves/secp256k1.js'
import {
  deriveNoteSecretKey,
  encodeCk1,
  signNoteOwnership,
  type Cx1
} from '@lnurlcash/kit'

const ROOT_KEY = 'lnurlcash-lottery:cash-root'
const INDICES_KEY = 'lnurlcash-lottery:cash-indices'

// Tags the stored root's derivation scheme so a root saved by an older
// version of this app (a BIP32 CashNode tree - a different derivation over
// the same byte length) is never silently reinterpreted as this scheme's
// seed bytes: that would derive different-but-plausible secrets with no
// error, and a recovery scan against tickets minted under the old scheme
// would just quietly find nothing. loadCashRoot treats anything not tagged
// this way as no seed active, same as any other unparseable value.
const ROOT_SCHEME = 'cx1-hkdf-v1'

export type CashRoot = Uint8Array

export type Branch = {privateKey: Uint8Array; chainCode: Uint8Array}

export const generateSeedPhrase = (): string => generateMnemonic(wordlist, 128)

export const isValidSeedPhrase = (phrase: string): boolean =>
  validateMnemonic(phrase.trim().toLowerCase(), wordlist)

export const cashRootFromPhrase = (phrase: string): CashRoot =>
  mnemonicToSeedSync(phrase.trim().toLowerCase())

export const hasCashRoot = (): boolean =>
  localStorage.getItem(ROOT_KEY) !== null

export const loadCashRoot = (): CashRoot | null => {
  const raw = localStorage.getItem(ROOT_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed?.scheme !== ROOT_SCHEME || typeof parsed.seedHex !== 'string') {
      return null
    }
    return hexToBytes(parsed.seedHex)
  } catch {
    return null
  }
}

export const saveCashRoot = (root: CashRoot): void => {
  localStorage.setItem(
    ROOT_KEY,
    JSON.stringify({scheme: ROOT_SCHEME, seedHex: bytesToHex(root)})
  )
}

// Forgets the root and every per-host counter derived under it. The notes
// it already minted are not affected - only recovering them without the
// phrase again is what this loses.
export const clearCashRoot = (): void => {
  localStorage.removeItem(ROOT_KEY)
  localStorage.removeItem(INDICES_KEY)
}

// Derives this seed's key material for one mint host - the "branch" every
// note index at that host is tweaked from (see deriveNoteSecretKey/
// deriveNotePubkey in @lnurlcash/kit). One HKDF call, domain-separated by
// host.
export const branchFor = (root: CashRoot, host: string): Branch => {
  const okm = hkdf(
    sha256,
    root,
    undefined,
    utf8ToBytes(`lnurlcash-lottery/branch/${host}`),
    64
  )
  return {privateKey: okm.slice(0, 32), chainCode: okm.slice(32)}
}

// The branch's own public half, for building the Cx1 a recovery scan walks
// (see recovery.ts's scanForNotes) - never discloses privateKey.
export const cx1BranchFor = (root: CashRoot, host: string): Cx1 => {
  const branch = branchFor(root, host)
  return {
    pubkeyXOnly: schnorr.getPublicKey(branch.privateKey),
    chainCode: branch.chainCode
  }
}

// ---- per-mint-host index counters ----

const readIndices = (): Record<string, number> => {
  try {
    const raw = localStorage.getItem(INDICES_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const writeIndex = (host: string, index: number): void => {
  writeIndices({...readIndices(), [host]: index})
}

const writeIndices = (indices: Record<string, number>): void => {
  localStorage.setItem(INDICES_KEY, JSON.stringify(indices))
}

export const nextIndexFor = (host: string): number => readIndices()[host] ?? 0

// Only ever raises a host's counter - a recovery scan finding a higher used
// index than what's locally recorded must never move it backwards, or a
// later split would re-derive (and collide with) an index already
// disclosed to the mint.
export const raiseIndexFor = (host: string, atLeast: number): void => {
  if (nextIndexFor(host) < atLeast) writeIndex(host, atLeast)
}

// Draws this host's next note secret and persists the counter before
// returning it - every draw must be durably recorded before the caller can
// do anything with it (see @lnurlcash/kit's AmbiguousMutationError docs: a
// secret handed out and then lost to a page reload before its mutation's
// fate is known is exactly the case that class exists to prevent on the
// package's side, and losing the index that produced it here would be the
// same mistake on this side). Reading nextIndexFor fresh here (rather than
// trusting an in-memory counter) means a fresh call after a reload always
// continues from the last persisted index, never replays one - the same
// index would mint a secret the mint has already seen, colliding with what
// it already issued.
export const nextCk1For = (root: CashRoot, host: string): string => {
  const branch = branchFor(root, host)
  const index = nextIndexFor(host)
  const secretKey = deriveNoteSecretKey(
    branch.privateKey,
    branch.chainCode,
    index
  )
  writeIndex(host, index + 1)
  return encodeCk1(signNoteOwnership(secretKey))
}
