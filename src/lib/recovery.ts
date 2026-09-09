// Finds notes this app minted under a seed but has no local record of - the
// PersistedRun that would normally list them was lost (cleared storage, a
// different browser, a crash outside the crash-safe window). Walks indices
// under the active cash root and asks the mint about each by hash, never
// disclosing a raw secret for one that turns out not to exist.
import {
  buildNoteUrl,
  cashSecretAt,
  deriveCashDomainNode,
  fetchNoteInfoByHash,
  hashK1,
  isAllowedServiceUrl,
  mergeNotes,
  noteK1,
  serverOf,
  verifyNoteSignature,
  withNewK1,
  type CashNode,
  type RandomSecret
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

export type TicketLiveness = {
  index: number
  k1: string
  amountMsat: number
  live: boolean
}

// Checks a list of *already-known* tickets (a finished run's own, not
// derived by walking indices) for whether each is still outstanding - a
// hash-only lookup per ticket, so a ticket that turns out to be already
// spent never has its raw secret put on the wire. Feeds the danger zone's
// "combine all unspent notes" action: mergeNotes fails outright if any
// named k1 isn't live, so this is what decides which ones are even safe to
// try.
export const checkTicketsLive = async (
  tickets: {index: number; noteUrl: string}[]
): Promise<TicketLiveness[]> => {
  const results: TicketLiveness[] = []
  for (const ticket of tickets) {
    const k1 = noteK1(ticket.noteUrl)
    if (!k1) {
      results.push({index: ticket.index, k1: '', amountMsat: 0, live: false})
      continue
    }
    try {
      const info = await fetchNoteInfoByHash(ticket.noteUrl, hashK1(k1))
      results.push({
        index: ticket.index,
        k1,
        amountMsat: info.maxWithdrawable,
        live: true
      })
    } catch {
      results.push({index: ticket.index, k1, amountMsat: 0, live: false})
    }
  }
  return results
}

export type CombinedNote = {
  noteUrl: string
  amountMsat: number
  verified: boolean
}

// Merges every recovered note into one, so the organizer has a single note
// to import into a wallet rather than one per index found. Burns every
// input in one atomic mutation - not reversible, and the caller must
// confirm with the organizer before calling this, same as splitting a note
// for a raffle. The merge itself doesn't report the result's value, so one
// hash-only lookup afterward (no extra secret disclosed) confirms it and
// gets a value to actually verify the signature against.
export const combineNotes = async (
  callback: string,
  k1s: string[],
  randomSecret?: RandomSecret
): Promise<CombinedNote> => {
  const merged = await mergeNotes(
    callback,
    k1s,
    randomSecret ? {randomSecret} : undefined
  )
  const info = await fetchNoteInfoByHash(callback, hashK1(merged.k1))
  const verified = merged.signature
    ? verifyNoteSignature(
        merged.k1,
        info.maxWithdrawable,
        merged.signature,
        info.mintPubkey
      )
    : false
  const bare = buildNoteUrl(info.callback, merged.k1, info.maxWithdrawable)
  const noteUrl =
    verified && merged.signature
      ? withNewK1(bare, merged.k1, info.maxWithdrawable, merged.signature)
      : bare
  return {noteUrl, amountMsat: info.maxWithdrawable, verified}
}
