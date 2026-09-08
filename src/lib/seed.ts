// Seed-recoverable ticket secrets (LUD-25). Generating or restoring a
//12-word BIP39 phrase here means every ticket a run mints can be
// re-derived later from the phrase alone - a lost PersistedRun record (see
// storage.ts) is a print-job to redo, not money gone; see recovery.ts for
// the scan that finds already-minted notes back from a phrase.
//
// The phrase itself is NEVER persisted - only the LUD-25 cash root derived
// from it (see lnurlcash-kit's deriveCashRoot), as hex, in localStorage.
// That's still bearer material for every note this browser will ever mint
// under it: anyone who reads it can derive every secret this app produces
// at every mint. Treat this device/browser storage with the same care as
// the notes themselves.
import {
  generateMnemonic,
  mnemonicToSeedSync,
  validateMnemonic
} from '@scure/bip39'
import {wordlist} from '@scure/bip39/wordlists/english.js'
import {
  cashNodeFromHex,
  cashNodeToHex,
  cashSecretSource,
  deriveCashRoot,
  type CashNode,
  type RandomSecret
} from 'lnurlcash-kit'

const ROOT_KEY = 'lnurlcash-lottery:cash-root'
const INDICES_KEY = 'lnurlcash-lottery:cash-indices'

export const generateSeedPhrase = (): string => generateMnemonic(wordlist, 128)

export const isValidSeedPhrase = (phrase: string): boolean =>
  validateMnemonic(phrase.trim().toLowerCase(), wordlist)

export const cashRootFromPhrase = (phrase: string): CashNode =>
  deriveCashRoot(mnemonicToSeedSync(phrase.trim().toLowerCase()))

export const hasCashRoot = (): boolean =>
  localStorage.getItem(ROOT_KEY) !== null

export const loadCashRoot = (): CashNode | null => {
  const hex = localStorage.getItem(ROOT_KEY)
  if (!hex) return null
  try {
    return cashNodeFromHex(hex)
  } catch {
    return null
  }
}

export const saveCashRoot = (root: CashNode): void => {
  localStorage.setItem(ROOT_KEY, cashNodeToHex(root))
}

// Forgets the root and every per-host counter derived under it. The notes
// it already minted are not affected - only recovering them without the
// phrase again is what this loses.
export const clearCashRoot = (): void => {
  localStorage.removeItem(ROOT_KEY)
  localStorage.removeItem(INDICES_KEY)
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

// Wraps lnurlcash-kit's cashSecretSource so every draw is durably persisted
// before the caller can do anything with it - see the kit's own README:
// "Persist that counter in the same write that stages the new records, and
// do it before the hash goes on the wire." Reading nextIndexFor fresh here
// (rather than trusting an in-memory counter passed in) means a fresh call
// after a page reload always continues from the last persisted index,
// never replays one - the same index would mint a secret the mint has
// already seen, colliding with what it already issued.
export const createPersistentRandomSecret = (
  root: CashNode,
  host: string
): RandomSecret => {
  const source = cashSecretSource(root, host, nextIndexFor(host))
  return () => {
    const secret = source()
    writeIndex(host, source.index())
    return secret
  }
}
