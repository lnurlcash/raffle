import type {LotteryConfig, TicketPlan} from './lottery'

// Only one run is ever tracked, in one localStorage slot. That is the
// crash-safety mechanism: every split this app performs burns real value, so
// the in-progress state - including any secret a request left ambiguous - is
// written here after every single step, before the UI moves on. A refresh,
// crash or closed tab mid-run loses nothing; see run.ts for how a resume
// picks this back up.
const STORAGE_KEY = 'lnurlcash-lottery:run'

export type TicketRecord = {
  index: number
  amountMsat: number
  label: string
  noteUrl: string
  verified: boolean
}

// A secret this app generated for a mutation whose outcome is unknown - the
// request timed out, dropped, or came back unparseable. It may already be a
// real note (see lnurlcash-kit's AmbiguousMutationError docs): never discard
// one of these without first probing whether it landed.
export type PendingSecret = {
  role: 'ticket' | 'change'
  k1: string
  nominalAmountMsat: number
}

// 'ambiguous': the mutation's fate is unknown - probe the input note before
// touching these secrets. 'confirmed': the service already said OK (just
// left the note unsigned) - these two secrets are real, only their exact
// value/callback still needs fetching.
export type PendingKind = 'ambiguous' | 'confirmed'

export type RunState = 'running' | 'needs-check' | 'error' | 'done'

export type CurrentNote = {
  k1: string
  amountMsat: number
  signature?: string
  callback: string
}

export type PersistedRun = {
  id: string
  createdAt: number
  updatedAt: number
  config: LotteryConfig
  mintPubkey: string
  plan: TicketPlan[]
  tickets: TicketRecord[]
  // the stable, informational-only address every ticket/leftover this run
  // produces gets printed with - established once, from the note the
  // organizer originally pasted in, and never replaced by a response's
  // `callback` field afterwards (see run.ts's startRun/foldSignedOutputs).
  // Distinct from `current.callback` below: that one is the live mutation
  // target for the *next* split or rotate, and a mint is free to answer
  // those two purposes at different endpoints - this mint does, so mixing
  // them up is exactly what produced a ticket that needed a rotate before
  // it worked at all, and separately, a split posted to the wrong endpoint
  // outright ("Specify exactly one of k1 or h").
  noteCallback: string
  // the note still being split down for the remaining plan entries; null
  // once every planned ticket has been minted (or the run gave up)
  current: CurrentNote | null
  // set only while the last attempt's fate is unknown - present alongside
  // `current` still pointing at the note that was being split, so a resume
  // knows exactly what to probe (or, if pendingKind is 'confirmed', just
  // what to settle)
  pending: PendingSecret[] | null
  pendingKind: PendingKind | null
  state: RunState
  message: string | null
  // the note left over after the last planned ticket - real value, never
  // printed, handed back to the organizer once the run finishes
  leftover: TicketRecord | null
  // total mint fees charged across every split in this run, in aggregate -
  // accumulated after every split as the gap between what its change output
  // should nominally be worth and what the mint actually confirms it's
  // worth. Starts at 0 and is trusted until the first confirmation lookup
  // that fails (a network hiccup, not a refusal): from then on it's null,
  // never assumed to be zero just because it's unknown.
  feesMsat: number | null
  // true if this run's secrets were derived from the active seed (see
  // seed.ts) rather than drawn from the CSPRNG - i.e. whether recovery.ts's
  // scan can find these tickets again from the seed phrase alone
  usesSeed: boolean
}

// A printed/stored ticket's noteUrl is meant to be redeemed on its own,
// independently, possibly long after this run - never posted straight back
// to a mutation-only endpoint. A trailing /cb is exactly that mutation
// endpoint (it answered a plain informational GET with "missing h" rather
// than a note's own value) leaking into a stored ticket instead of the
// redeemable one - always wrong to find there, not a guess. run.ts no
// longer ever writes this (see noteCallback/startRun, which now carries a
// note's own url forward instead of trusting a response's callback field),
// so this only ever cleans up data from before that fix. Only ever applied
// to a ticket's own noteUrl, never `current.callback`: that one
// legitimately IS the mutation endpoint, since it's what the next split or
// rotate in a live run posts to.
const stripCbSegment = (url: string): string => {
  try {
    const parsed = new URL(url)
    if (!parsed.pathname.endsWith('/cb')) return url
    parsed.pathname = parsed.pathname.slice(0, -'/cb'.length) || '/'
    return parsed.toString()
  } catch {
    return url
  }
}

const migrateTicket = (ticket: TicketRecord): TicketRecord => {
  const noteUrl = stripCbSegment(ticket.noteUrl)
  return noteUrl === ticket.noteUrl ? ticket : {...ticket, noteUrl}
}

// One-time cleanup for tickets/leftovers persisted before run.ts stopped
// producing this - see foldSignedOutputs, finishWithRemainderAsFinalTicket
// and continueRun's leftover construction. A fresh split can no longer
// write a /cb-suffixed ticket noteUrl, so this only ever cleans up old
// data; it can't be reintroduced by anything written after this fix.
const migrateRun = (run: PersistedRun): PersistedRun => {
  const tickets = run.tickets.map(migrateTicket)
  const leftover = run.leftover ? migrateTicket(run.leftover) : run.leftover
  if (
    tickets.every((t, i) => t === run.tickets[i]) &&
    leftover === run.leftover
  ) {
    return run
  }
  return {...run, tickets, leftover}
}

export const loadRun = (): PersistedRun | null => {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  let parsed: PersistedRun
  try {
    parsed = JSON.parse(raw) as PersistedRun
  } catch {
    return null
  }
  const migrated = migrateRun(parsed)
  if (migrated !== parsed) saveRun(migrated)
  return migrated
}

export const saveRun = (run: PersistedRun): void => {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({...run, updatedAt: Date.now()})
  )
}

export const clearRun = (): void => {
  localStorage.removeItem(STORAGE_KEY)
}

// true while discarding the record would forget about real, possibly-spent
// money: an unresolved ambiguous mutation, or a note still sitting unspent
// (mid-run) that the organizer hasn't been shown yet.
export const hasUnresolvedFunds = (run: PersistedRun): boolean =>
  run.state !== 'done' &&
  (run.pending !== null || run.current !== null || run.tickets.length > 0)
