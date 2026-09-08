// Finds notes this app minted under a seed but has no local record of - the
// PersistedRun that would normally list them was lost (cleared storage, a
// different browser, a crash outside the crash-safe window). Walks indices
// under the active cash root and asks the mint about each by hash, never
// disclosing a raw secret for one that turns out not to exist.
import {
  cashSecretAt,
  deriveCashDomainNode,
  fetchNoteInfoByHash,
  hashK1,
  isAllowedServiceUrl,
  serverOf,
  type CashNode
} from 'lnurlcash-kit'
import {raiseIndexFor} from './seed'

export type RecoveredNote = {
  index: number
  k1: string
  amountMsat: number
  callback: string
}

export type ScanProgress = {index: number; foundCount: number}

// Standard HD-wallet gap-limit convention (also what lnurl-wallet's own
// mint recovery uses): stop after this many consecutive indices come back
// unknown, on the assumption nothing beyond that point was ever minted.
const GAP_LIMIT = 20

// A hash lookup answers the same way for "spent" and "never minted" (LUD-25
// privacy: neither leaks more than the other) - so every miss here is
// genuinely ambiguous between the two, and that ambiguity is fine: either
// way, that index isn't a note this scan should report as recoverable.
export const scanForNotes = async (
  root: CashNode,
  withdrawLink: string,
  onProgress?: (progress: ScanProgress) => void
): Promise<RecoveredNote[]> => {
  if (!isAllowedServiceUrl(withdrawLink)) {
    throw new Error(
      'That is not a service URL this app will contact (needs https, or http only for a local/.onion dev host).'
    )
  }
  const host = serverOf(withdrawLink)
  const domainNode = deriveCashDomainNode(root, host)
  const found: RecoveredNote[] = []
  let misses = 0
  let index = 0
  while (misses < GAP_LIMIT) {
    const k1 = cashSecretAt(domainNode, index)
    try {
      const info = await fetchNoteInfoByHash(withdrawLink, hashK1(k1))
      found.push({
        index,
        k1,
        amountMsat: info.maxWithdrawable,
        callback: info.callback
      })
      misses = 0
    } catch {
      misses++
    }
    onProgress?.({index, foundCount: found.length})
    index++
  }
  if (found.length > 0) {
    raiseIndexFor(host, Math.max(...found.map(n => n.index)) + 1)
  }
  return found
}
