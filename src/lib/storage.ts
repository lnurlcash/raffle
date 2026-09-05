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
}

export const loadRun = (): PersistedRun | null => {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as PersistedRun
  } catch {
    return null
  }
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
