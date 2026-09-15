// Finds notes this app minted under a seed but has no local record of - the
// PersistedRun that would normally list them was lost (cleared storage, a
// different browser, a crash outside the crash-safe window). Walks this
// seed's branch at the given mint via @lnurlcash/kit's own gap-limit scan
// (scanForAddressNotes), then re-derives each found index's own secret
// locally - the scan itself only ever discloses derived pubkeys, never a
// spendable secret for an index that turns out not to exist.
import {
  buildNoteUrl,
  cp1FromCk1,
  deriveNoteSecretKey,
  encodeCk1,
  fetchNoteInfoByHash,
  fetchNoteInfoByPubkey,
  hashK1,
  isAllowedServiceUrl,
  isCk1,
  mergeNotes,
  noteK1,
  scanForAddressNotes,
  serverOf,
  signNoteOwnership,
  verifyNoteSignature,
  withNewK1
} from '@lnurlcash/kit'
import {branchFor, cx1BranchFor, raiseIndexFor, type CashRoot} from './seed'

export type RecoveredNote = {
  index: number
  k1: string
  amountMsat: number
  callback: string
}

export type ScanProgress = {index: number; foundCount: number}

// A hash-only lookup is only a valid privacy-preserving check for a legacy
// secret - a ck1 (Part 2 recoverable) secret is indexed by its mint by the
// pubkey it discloses, not a hash of the signature itself, so hashK1(k1)
// would look up nothing for one of those. Any output this app mints while a
// seed is active is a ck1 (see seed.ts's nextCk1For), so both forms can show
// up side by side depending on whether a seed was active when a given
// ticket was minted.
const fetchNoteInfoForK1 = (url: string, k1: string) => {
  if (isCk1(k1)) {
    const cp1 = cp1FromCk1(k1)
    if (!cp1) throw new Error("This note's ck1 secret is malformed.")
    return fetchNoteInfoByPubkey(url, cp1)
  }
  return fetchNoteInfoByHash(url, hashK1(k1))
}

// A hash lookup (and, equally, a pubkey lookup) answers the same way for
// "spent" and "never minted" (LUD-25 privacy: neither leaks more than the
// other) - so scanForAddressNotes treating a spent index as "keep scanning,
// but don't report it as found" is the right call, same as this scan
// reported before: either way, that index isn't a note this scan should
// hand back as recoverable.
export const scanForNotes = async (
  root: CashRoot,
  withdrawLink: string,
  onProgress?: (progress: ScanProgress) => void
): Promise<RecoveredNote[]> => {
  if (!isAllowedServiceUrl(withdrawLink)) {
    throw new Error(
      'That is not a service URL this app will contact (needs https, or http only for a local/.onion dev host).'
    )
  }
  const host = serverOf(withdrawLink)
  const branch = branchFor(root, host)
  const cx1Branch = cx1BranchFor(root, host)
  const found: RecoveredNote[] = []
  const results = await scanForAddressNotes(withdrawLink, cx1Branch, {
    onFound: result => {
      found.push({
        index: result.index,
        // placeholder - replaced with the real spendable secret below, kept
        // out of the scan step itself so nothing here ever handles a raw
        // secret for an index that later turns out unspendable
        k1: '',
        amountMsat: result.info.maxWithdrawable,
        callback: result.info.callback
      })
      onProgress?.({index: result.index, foundCount: found.length})
    }
  })
  for (const entry of found) {
    const secretKey = deriveNoteSecretKey(
      branch.privateKey,
      branch.chainCode,
      entry.index
    )
    entry.k1 = encodeCk1(signNoteOwnership(secretKey))
  }
  if (results.length > 0) {
    raiseIndexFor(host, Math.max(...results.map(r => r.index)) + 1)
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
// hash/pubkey-only lookup per ticket, so a ticket that turns out to be
// already spent never has its raw secret put on the wire. Feeds the danger
// zone's "combine all unspent notes" action: mergeNotes fails outright if
// any named k1 isn't live, so this is what decides which ones are even safe
// to try.
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
      const info = await fetchNoteInfoForK1(ticket.noteUrl, k1)
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
// hash/pubkey-only lookup afterward (no extra secret disclosed) confirms it
// and gets a value to actually verify the signature against.
export const combineNotes = async (
  callback: string,
  k1s: string[]
): Promise<CombinedNote> => {
  const merged = await mergeNotes(callback, k1s)
  const info = await fetchNoteInfoForK1(callback, merged.k1)
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
