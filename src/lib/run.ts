// Splits one bearer note down into every ticket a lottery config plans,
// one splitNote call per ticket. Every step is persisted (see storage.ts)
// before this function does anything else with the result, because every
// step here can move real money and a dropped connection does not mean
// nothing happened - see @lnurlcash/kit's THREAT-MODEL.md and its
// AmbiguousMutationError docs. Read those before changing this file.
import {
  resolveNoteInput,
  fetchNoteInfo,
  fetchNoteInfoByHash,
  fetchNoteInfoByPubkey,
  hashK1,
  splitNote,
  rotateNote,
  buildNoteUrl,
  withNewK1,
  requireNoteK1,
  verifyNoteSignature,
  probeBurnedNote,
  isCk1,
  cp1FromCk1,
  AmbiguousMutationError,
  PendingNoteError
} from '@lnurlcash/kit'
import {planTickets, type LotteryConfig, type TicketPlan} from './lottery'
import type {CashRoot} from './seed'
import {
  saveRun,
  type PersistedRun,
  type TicketRecord,
  type CurrentNote,
  type PendingSecret
} from './storage'

// `run` is mutated in place throughout this file - one consistent working
// object for the whole operation, simplest thing that works internally. But
// handing that same reference to onUpdate/setRun on every call means a
// signal-based UI (Solid, this app's) sees an identical object reference
// each time and can skip re-rendering on the assumption nothing changed -
// silently dropping every update but whichever one happens to coincide with
// some unrelated re-render, which is exactly how a finished run could show
// stale progress with none of its action buttons. A shallow copy costs
// nothing and guarantees every step is its own distinct, observable value.
// A hash-only lookup is only a valid privacy-preserving check for a legacy
// secret - a ck1 (Part 2 recoverable) secret is indexed by its mint by the
// pubkey it discloses, not a hash of the signature itself, so hashK1(k1)
// would look up nothing for one of those. See seed.ts's nextCk1For: any
// output this app mints while a seed is active is a ck1, so both forms can
// show up side by side in the same run.
const fetchNoteInfoForK1 = (url: string, k1: string) => {
  if (isCk1(k1)) {
    const cp1 = cp1FromCk1(k1)
    if (!cp1) throw new Error("This note's ck1 secret is malformed.")
    return fetchNoteInfoByPubkey(url, cp1)
  }
  return fetchNoteInfoByHash(url, hashK1(k1))
}

const emit = (run: PersistedRun, onUpdate: (run: PersistedRun) => void) => {
  saveRun(run)
  onUpdate({...run})
}

const noteUrlOf = (note: CurrentNote): string => {
  const bare = buildNoteUrl(note.callback, note.k1, note.amountMsat)
  return note.signature
    ? withNewK1(bare, note.k1, note.amountMsat, note.signature)
    : bare
}

// The inverse of noteUrlOf: recovers the callback a noteUrl was built from.
// Used only to read back a ticket's own already-stable callback (e.g. for
// rotate's output) - never to invent one for storing/printing from a
// response body. See PersistedRun.noteCallback for why a response's
// `callback` field is a different thing entirely, not interchangeable with
// this: that field is a live mutation target this mint answers at a
// separate endpoint from the note's own informational one.
const bareCallbackOf = (noteUrl: string): string => {
  const parsed = new URL(noteUrl)
  parsed.searchParams.delete('k1')
  parsed.searchParams.delete('amount')
  parsed.searchParams.delete('sig')
  return parsed.toString()
}

const failWith = (
  run: PersistedRun,
  onUpdate: (run: PersistedRun) => void,
  message: string
): void => {
  run.state = 'error'
  run.message = message
  emit(run, onUpdate)
}

// The ordinary happy path: splitNote already resolved, so both outputs
// already carry a mint-issued signature (splitNoteWithHash's
// requireMutationSignature throws otherwise, wrapped into
// AmbiguousMutationError - see foldRecoveredOutputs for that case), and the
// ticket's own value is exact - LUD-25 mints the h output at precisely the
// amount requested. The h2/change side is the one place a mint-charged
// split fee can hide, and trusting a nominal estimate for it (payout minus
// the ticket) let that estimate drift from what the mint actually left
// behind - silently, until a later split asked for more than was really
// there and failed. So every split confirms the change's authoritative
// value with one hash/pubkey-only lookup (no k1 disclosed, no rotate,
// nothing mutated - not the extra mutation rotateNote costs) before
// `current` moves on to it. That lookup's own `callback` is what `current`
// carries forward too: it's the live mutation target for the *next* split
// or rotate, which this mint answers at a different endpoint than a plain
// informational GET - reusing a stale one is what a "Specify exactly one
// of k1 or h" refusal on the following split came from.
//
// The *ticket's own printed noteUrl* never gets this value - it always
// gets run.noteCallback, the stable informational address established once
// at startRun. A response's `callback` field is that request's own POST
// target, not a durable note address, and printing one of those on a
// ticket produced a note that needed a rotate before it worked at all. A
// failed value confirmation (a network hiccup, not a refusal) keeps the
// nominal estimate and the previous callback rather than blocking an
// otherwise-successful split, but marks the running fee total unknown from
// there on, rather than silently wrong.
const foldSignedOutputs = async (
  run: PersistedRun,
  ticket: TicketPlan,
  ticketK1: string,
  ticketSignature: string,
  changeK1: string,
  changeSignature: string
): Promise<void> => {
  const current = run.current!

  const nominalChangeAmountMsat = current.amountMsat - ticket.amountMsat
  let changeAmountMsat = nominalChangeAmountMsat
  let changeCallback = current.callback
  try {
    const changeInfo = await fetchNoteInfoForK1(current.callback, changeK1)
    changeAmountMsat = changeInfo.maxWithdrawable
    changeCallback = changeInfo.callback
    if (run.feesMsat !== null) {
      run.feesMsat += nominalChangeAmountMsat - changeAmountMsat
    }
  } catch {
    run.feesMsat = null
  }

  const verified = verifyNoteSignature(
    ticketK1,
    ticket.amountMsat,
    ticketSignature,
    run.mintPubkey
  )
  const record: TicketRecord = {
    index: ticket.index,
    amountMsat: ticket.amountMsat,
    label: ticket.label,
    noteUrl: noteUrlOf({
      k1: ticketK1,
      amountMsat: ticket.amountMsat,
      signature: verified ? ticketSignature : undefined,
      callback: run.noteCallback
    }),
    verified
  }
  run.tickets = [...run.tickets, record]

  run.current = {
    k1: changeK1,
    amountMsat: changeAmountMsat,
    signature: changeSignature,
    callback: changeCallback
  }
  run.pending = null
  run.pendingKind = null
}

// The recovery path: all we have is two secrets this app generated, with no
// signature - either the mint confirmed a split without signing it, or a
// split whose fate was ambiguous turned out to have landed. @lnurlcash/kit
// no longer offers a "confirm or fetch a signature" settleNote - rotating
// each one is the only way left to get an offline-verifiable signature (and
// a fresh k1 along with it - see fetchNoteInfoForK1 for the authoritative
// value that comes with it), which is exactly what rotateNote is for.
// Unlike the happy path above, this extra round trip per output is the
// point here, not overhead to avoid.
const foldRecoveredOutputs = async (
  run: PersistedRun,
  ticket: TicketPlan,
  ticketK1: string,
  changeK1: string
): Promise<void> => {
  const current = run.current!
  const ticketRotated = await rotateNote(current.callback, ticketK1)
  const ticketInfo = await fetchNoteInfoForK1(
    current.callback,
    ticketRotated.k1
  )
  const nominalChangeAmountMsat = current.amountMsat - ticket.amountMsat
  const changeRotated = await rotateNote(current.callback, changeK1)
  const changeInfo = await fetchNoteInfoForK1(
    current.callback,
    changeRotated.k1
  )
  if (run.feesMsat !== null) {
    run.feesMsat += nominalChangeAmountMsat - changeInfo.maxWithdrawable
  }
  const verified = verifyNoteSignature(
    ticketRotated.k1,
    ticketInfo.maxWithdrawable,
    ticketRotated.signature,
    run.mintPubkey
  )
  const record: TicketRecord = {
    index: ticket.index,
    amountMsat: ticketInfo.maxWithdrawable,
    label: ticket.label,
    noteUrl: noteUrlOf({
      k1: ticketRotated.k1,
      amountMsat: ticketInfo.maxWithdrawable,
      signature: verified ? ticketRotated.signature : undefined,
      callback: run.noteCallback
    }),
    verified
  }
  run.tickets = [...run.tickets, record]
  run.current = {
    k1: changeRotated.k1,
    amountMsat: changeInfo.maxWithdrawable,
    signature: changeRotated.signature,
    callback: changeInfo.callback
  }
  run.pending = null
  run.pendingKind = null
}

// Finishes the run by taking whatever `current` is actually worth as the
// final planned ticket, instead of splitting off the configured amount -
// for when there isn't enough left for it (mint fees already charged along
// the way ate into a plan that assumed none). Only ever the right call for
// the very last ticket: anything after it still needs funding from what
// would remain, so a shortfall there is a real problem to report, not one
// this can quietly paper over. Re-checks the authoritative value itself
// (rather than trusting whatever `current.amountMsat` already says) so this
// still works on a run whose bookkeeping predates this app tracking fees
// accurately after every split.
const finishWithRemainderAsFinalTicket = async (
  run: PersistedRun,
  ticket: TicketPlan,
  onUpdate: (run: PersistedRun) => void
): Promise<void> => {
  const current = run.current!
  let amountMsat = current.amountMsat
  try {
    const info = await fetchNoteInfoForK1(current.callback, current.k1)
    amountMsat = info.maxWithdrawable
  } catch {
    // couldn't refresh - fall back to whatever this run already believed
  }
  if (amountMsat <= 0) {
    failWith(
      run,
      onUpdate,
      `Nothing is left for the final ticket after mint fees. The ${run.tickets.length} ticket(s) already minted are safe.`
    )
    return
  }
  const verified = current.signature
    ? verifyNoteSignature(
        current.k1,
        amountMsat,
        current.signature,
        run.mintPubkey
      )
    : false
  const record: TicketRecord = {
    index: ticket.index,
    amountMsat,
    label: ticket.label,
    noteUrl: noteUrlOf({
      k1: current.k1,
      amountMsat,
      signature: verified ? current.signature : undefined,
      callback: run.noteCallback
    }),
    verified
  }
  run.tickets = [...run.tickets, record]
  run.current = null
  run.leftover = null
  run.pending = null
  run.pendingKind = null
  run.state = 'done'
  run.message =
    amountMsat < ticket.amountMsat
      ? `The final ticket was reduced to ${Math.floor(amountMsat / 1000).toLocaleString()} sat (configured as ${Math.floor(ticket.amountMsat / 1000).toLocaleString()} sat) - mint fees left less than planned.`
      : null
  emit(run, onUpdate)
}

// A mutation whose success we cannot confirm. Every branch here either
// stashes the fresh secrets this app generated (never invented by the
// service - see @lnurlcash/kit's rotate/split contract) before returning, or
// determines definitively that nothing was lost.
const handleMutationError = async (
  err: unknown,
  run: PersistedRun,
  ticket: TicketPlan,
  isLastTicket: boolean,
  onUpdate: (run: PersistedRun) => void
): Promise<void> => {
  // @lnurlcash/kit no longer distinguishes "confirmed OK but unsigned" from
  // "genuinely uncertain whether it landed" (the old package's separate
  // UnverifiableNoteError is gone) - splitNote/rotateNote/mergeNotes wrap
  // every such case in the same AmbiguousMutationError now, carrying
  // whatever fresh secrets they minted. Always probe before settling
  // (pendingKind 'ambiguous') rather than assuming success, since there's
  // no longer a way to tell the two cases apart up front.
  if (err instanceof AmbiguousMutationError) {
    const secrets = err.newSecrets
    run.pending = [
      {role: 'ticket', k1: secrets[0]!, nominalAmountMsat: ticket.amountMsat},
      {
        role: 'change',
        k1: secrets[1]!,
        nominalAmountMsat: run.current!.amountMsat - ticket.amountMsat
      }
    ]
    run.pendingKind = 'ambiguous'
    run.state = 'needs-check'
    run.message = err.message
    emit(run, onUpdate)
    return
  }
  if (err instanceof PendingNoteError) {
    run.state = 'needs-check'
    run.message =
      'This note has another operation in progress at the mint. Wait a moment, then resume.'
    emit(run, onUpdate)
    return
  }
  // A definitive refusal with nothing landed - if it's the last ticket, the
  // likeliest cause is mint fees having eaten the margin a zero-fee plan
  // assumed would still be there. Finish with whatever's actually left
  // rather than leaving an otherwise-successful run stuck.
  if (isLastTicket) {
    await finishWithRemainderAsFinalTicket(run, ticket, onUpdate)
    return
  }
  failWith(run, onUpdate, err instanceof Error ? err.message : String(err))
}

// Resolves a stashed pending secret pair, if any. Ambiguous pairs are
// probed first (did the split actually land?); confirmed pairs go straight
// to settling. Returns true if the run is clear to keep splitting.
export const resolvePending = async (
  run: PersistedRun,
  ticket: TicketPlan,
  onUpdate: (run: PersistedRun) => void
): Promise<boolean> => {
  if (!run.pending || !run.current) return true
  const [ticketPending, changePending] = run.pending
  if (run.pendingKind === 'ambiguous') {
    const fate = await probeBurnedNote(noteUrlOf(run.current))
    if (fate === 'live') {
      // nothing landed - the staged secrets mint nothing, safe to drop
      run.pending = null
      run.pendingKind = null
      run.state = 'running'
      run.message = null
      emit(run, onUpdate)
      return true
    }
    if (fate === 'unknown') {
      run.state = 'needs-check'
      run.message =
        'Still unable to tell whether that split landed. Nothing is lost - try "check pending" again shortly.'
      emit(run, onUpdate)
      return false
    }
    // 'gone': the burn landed, fall through to settle the two secrets below
  }
  try {
    await foldRecoveredOutputs(
      run,
      ticket,
      ticketPending!.k1,
      changePending!.k1
    )
    run.state = 'running'
    run.message = null
    emit(run, onUpdate)
    return true
  } catch (settleErr) {
    run.state = 'needs-check'
    run.message = `Split landed but could not be settled yet: ${(settleErr as Error).message}. Nothing is lost - try "check pending" again.`
    emit(run, onUpdate)
    return false
  }
}

// The main loop: split one planned ticket at a time off `run.current` until
// every plan entry has been minted, then hand back whatever is left as the
// unprinted leftover note.
const continueRun = async (
  run: PersistedRun,
  onUpdate: (run: PersistedRun) => void
): Promise<void> => {
  while (run.current && run.tickets.length < run.plan.length) {
    const ticket = run.plan[run.tickets.length]!
    const isLastTicket = run.tickets.length === run.plan.length - 1

    if (run.pending) {
      const clear = await resolvePending(run, ticket, onUpdate)
      if (!clear) return
      continue
    }

    // Fail fast and clearly rather than sending a request that can only be
    // refused: `current.amountMsat` is kept authoritative after every split
    // (see foldSignedOutputs), so this is a real shortfall - mint fees
    // already charged along the way ate into what a zero-fee plan assumed
    // would still be here - not a stale estimate catching up with reality.
    // For the last ticket specifically, that's not fatal: nothing after it
    // needs funding, so it can just become whatever is actually left.
    if (run.current.amountMsat < ticket.amountMsat) {
      if (isLastTicket) {
        await finishWithRemainderAsFinalTicket(run, ticket, onUpdate)
        return
      }
      failWith(
        run,
        onUpdate,
        `Not enough left after mint fees for the next ticket: needs ${Math.floor(ticket.amountMsat / 1000).toLocaleString()} sat, only ${Math.floor(run.current.amountMsat / 1000).toLocaleString()} sat remains. The ${run.tickets.length} ticket(s) already minted are safe - reduce the remaining prize tiers, or top up and resume.`
      )
      return
    }

    try {
      const split = await splitNote(
        run.current.callback,
        [run.current.k1],
        ticket.amountMsat
      )
      if (!split.signature || !split.changeSignature) {
        // shouldn't happen - splitNote's default requireSignatures throws
        // UnverifiableNoteError rather than resolving without one
        throw new Error(
          'The mint confirmed the split but splitNote resolved without a signature.'
        )
      }
      await foldSignedOutputs(
        run,
        ticket,
        split.k1,
        split.signature,
        split.change,
        split.changeSignature
      )
      run.state = 'running'
      run.message = null
      emit(run, onUpdate)
    } catch (err) {
      await handleMutationError(err, run, ticket, isLastTicket, onUpdate)
      if (run.state !== 'running') return
    }
  }

  if (run.current && run.tickets.length === run.plan.length) {
    // current.amountMsat is already authoritative here - confirmed after
    // every split along the way (see foldSignedOutputs/foldRecoveredOutputs)
    // - so only the callback needs swapping: current.callback is the live
    // mutation endpoint, never what gets printed (see noteCallback).
    const leftover: TicketRecord = {
      index: -1,
      amountMsat: run.current.amountMsat,
      label: 'Leftover (not printed)',
      noteUrl: noteUrlOf({...run.current, callback: run.noteCallback}),
      verified: run.current.signature
        ? verifyNoteSignature(
            run.current.k1,
            run.current.amountMsat,
            run.current.signature,
            run.mintPubkey
          )
        : false
    }
    run.leftover = leftover
    run.current = null
    run.state = 'done'
    run.message = null
    emit(run, onUpdate)
  }
}

export const startRun = async (
  noteInput: string,
  config: LotteryConfig,
  onUpdate: (run: PersistedRun) => void,
  cashRoot: CashRoot | null = null
): Promise<void> => {
  const url = resolveNoteInput(noteInput)
  if (!url) throw new Error('That is not a recognizable bearer note.')
  const info = await fetchNoteInfo(url)
  const plan = planTickets(config)
  const requestedMsat = plan.reduce((n, t) => n + t.amountMsat, 0)
  if (requestedMsat > info.maxWithdrawable) {
    throw new Error(
      `Prize total is ${Math.floor(requestedMsat / 1000).toLocaleString()} sat, ` +
        `but the note only carries ${Math.floor(info.maxWithdrawable / 1000).toLocaleString()} sat.`
    )
  }
  const run: PersistedRun = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    config,
    mintPubkey: info.mintPubkey,
    plan,
    tickets: [],
    // the stable, informational address every ticket this run mints gets
    // printed with - see PersistedRun.noteCallback
    noteCallback: bareCallbackOf(url),
    current: {
      k1: info.k1,
      amountMsat: info.maxWithdrawable,
      // the live mutation target, from the informational response - not
      // the same thing as noteCallback above, see that field's comment
      callback: info.callback
    },
    pending: null,
    pendingKind: null,
    state: 'running',
    message: null,
    leftover: null,
    feesMsat: 0,
    usesSeed: cashRoot !== null
  }
  emit(run, onUpdate)
  await continueRun(run, onUpdate)
}

export const resumeRun = async (
  run: PersistedRun,
  onUpdate: (run: PersistedRun) => void
): Promise<void> => {
  run.state = 'running'
  emit(run, onUpdate)
  await continueRun(run, onUpdate)
}

// Manual retry for a run parked in 'needs-check' - re-probes/settles the
// stashed pending secrets, and keeps splitting if that clears it.
export const checkPending = async (
  run: PersistedRun,
  onUpdate: (run: PersistedRun) => void
): Promise<void> => {
  await continueRun(run, onUpdate)
}

// Refreshes one already-minted ticket (or the leftover) after the run
// itself is done: rotates it to obtain a fresh, offline-verifiable
// signature, then confirms its authoritative value with a follow-up
// informational lookup (rotateNote itself doesn't report a value). This is
// not part of splitting: it's for a ticket the organizer is checking or
// taking back, and rotating BURNS whatever secret is currently printed on
// it, minting a new one only the caller learns - see the "danger zone"
// warning wherever this is wired into the UI. Everything it needs (k1,
// callback) already lives in the ticket's own noteUrl, so no other run
// state is required to call it.
export const rotateTicketRecord = async (
  ticket: TicketRecord,
  mintPubkey: string
): Promise<TicketRecord> => {
  const k1 = requireNoteK1(ticket.noteUrl)
  let rotated
  try {
    rotated = await rotateNote(ticket.noteUrl, k1)
  } catch (err) {
    if (err instanceof AmbiguousMutationError) {
      // the rotate's fate is ambiguous and it minted a fresh secret that
      // might already be a live note - swallowing that here would lose it
      // for good, so it's surfaced instead of ever silently discarded.
      throw new Error(
        `Rotate's outcome is unknown: ${err.message} A new secret may already be a real note - do not discard it: ${err.newSecrets.join(', ')}`
      )
    }
    // any other failure is a clean refusal - nothing committed, nothing
    // burned, the ticket is exactly as it was before.
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(
      `The mint refused to rotate this note: ${detail} Nothing was changed, the ticket is exactly as it was before.`
    )
  }
  const info = await fetchNoteInfoForK1(ticket.noteUrl, rotated.k1)
  const verified = verifyNoteSignature(
    rotated.k1,
    info.maxWithdrawable,
    rotated.signature,
    mintPubkey
  )
  return {
    ...ticket,
    amountMsat: info.maxWithdrawable,
    noteUrl: noteUrlOf({
      k1: rotated.k1,
      amountMsat: info.maxWithdrawable,
      signature: verified ? rotated.signature : undefined,
      // never info.callback (that's a live mutation target, not a
      // printable address - see PersistedRun.noteCallback). The ticket's
      // own url already carries the note's stable address; a rotate only
      // ever changes its k1/signature/value, never where it lives.
      callback: bareCallbackOf(ticket.noteUrl)
    }),
    verified
  }
}
