// Splits one bearer note down into every ticket a lottery config plans,
// one splitNote call per ticket. Every step is persisted (see storage.ts)
// before this function does anything else with the result, because every
// step here can move real money and a dropped connection does not mean
// nothing happened - see lnurlcash-kit's README, "The five things that will
// cost you money". Read that before changing this file.
import {
  resolveNoteInput,
  fetchNoteInfo,
  splitNote,
  settleNote,
  buildNoteUrl,
  withNewK1,
  verifyNoteSignature,
  probeBurnedNote,
  newSecretsOf,
  AmbiguousMintError,
  PendingNoteError
} from 'lnurlcash-kit'
import {planTickets, type LotteryConfig, type TicketPlan} from './lottery'
import {
  saveRun,
  type PersistedRun,
  type TicketRecord,
  type CurrentNote,
  type PendingSecret
} from './storage'

const emit = (run: PersistedRun, onUpdate: (run: PersistedRun) => void) => {
  saveRun(run)
  onUpdate(run)
}

const noteUrlOf = (note: CurrentNote): string => {
  const bare = buildNoteUrl(note.callback, note.k1, note.amountMsat)
  return note.signature
    ? withNewK1(bare, note.k1, note.amountMsat, note.signature)
    : bare
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

// Folds two now-known-real secrets (the ticket output and the change output
// of one split) into the run: fetches each one's authoritative value and
// callback, then appends the ticket and advances `current` to the change.
// Used both by the ordinary happy path and by pending-secret resolution -
// the two differ only in whether a signature is available to carry along.
const foldSplitOutputs = async (
  run: PersistedRun,
  ticket: TicketPlan,
  ticketK1: string,
  ticketSignature: string | undefined,
  changeK1: string,
  changeSignature: string | undefined
): Promise<void> => {
  const current = run.current!
  const ticketSettled = await settleNote(
    current.callback,
    ticketK1,
    ticket.amountMsat,
    ticketSignature
  )
  const changeSettled = await settleNote(
    current.callback,
    changeK1,
    current.amountMsat - ticket.amountMsat,
    changeSignature
  )
  const verified = ticketSettled.signature
    ? verifyNoteSignature(
        ticketSettled.k1,
        ticketSettled.amountMsat,
        ticketSettled.signature,
        run.mintPubkey
      )
    : false
  const record: TicketRecord = {
    index: ticket.index,
    amountMsat: ticketSettled.amountMsat,
    label: ticket.label,
    noteUrl: noteUrlOf({
      k1: ticketSettled.k1,
      amountMsat: ticketSettled.amountMsat,
      signature: verified ? ticketSettled.signature : undefined,
      callback: ticketSettled.callback
    }),
    verified
  }
  run.tickets = [...run.tickets, record]
  run.current = {
    k1: changeSettled.k1,
    amountMsat: changeSettled.amountMsat,
    signature: changeSettled.signature,
    callback: changeSettled.callback
  }
  run.pending = null
  run.pendingKind = null
}

// A mutation whose success we cannot confirm. Every branch here either
// stashes the fresh secrets this app generated (never invented by the
// service - see lnurlcash-kit's rotate/split contract) before returning, or
// determines definitively that nothing was lost.
const handleMutationError = async (
  err: unknown,
  run: PersistedRun,
  ticket: TicketPlan,
  onUpdate: (run: PersistedRun) => void
): Promise<void> => {
  const secrets = newSecretsOf(err)
  if (secrets.length === 2 && !(err instanceof AmbiguousMintError)) {
    // The service confirmed OK but didn't sign the outputs - landed for
    // certain, just unverifiable. Try to fold it in immediately; if that
    // itself fails, the secrets are not lost - they sit in `pending` marked
    // 'confirmed' so a later check retries only the settle, never a probe.
    run.pending = [
      {role: 'ticket', k1: secrets[0]!, nominalAmountMsat: ticket.amountMsat},
      {
        role: 'change',
        k1: secrets[1]!,
        nominalAmountMsat: run.current!.amountMsat - ticket.amountMsat
      }
    ]
    run.pendingKind = 'confirmed'
    emit(run, onUpdate)
    try {
      await foldSplitOutputs(
        run,
        ticket,
        secrets[0]!,
        undefined,
        secrets[1]!,
        undefined
      )
      run.message =
        'One ticket could not be offline-verified (the mint did not sign it), but the split did complete and the ticket is real.'
      emit(run, onUpdate)
    } catch (settleErr) {
      run.state = 'needs-check'
      run.message = `Split completed but could not be settled yet: ${(settleErr as Error).message}. Nothing is lost - use "check pending" to retry.`
      emit(run, onUpdate)
    }
    return
  }
  if (err instanceof AmbiguousMintError) {
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
    run.message = (err as Error).message
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
    await foldSplitOutputs(
      run,
      ticket,
      ticketPending!.k1,
      undefined,
      changePending!.k1,
      undefined
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

    if (run.pending) {
      const clear = await resolvePending(run, ticket, onUpdate)
      if (!clear) return
      continue
    }

    try {
      const split = await splitNote(
        run.current.callback,
        [run.current.k1],
        ticket.amountMsat
      )
      await foldSplitOutputs(
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
      await handleMutationError(err, run, ticket, onUpdate)
      if (run.state !== 'running') return
    }
  }

  if (run.current && run.tickets.length === run.plan.length) {
    const leftover: TicketRecord = {
      index: -1,
      amountMsat: run.current.amountMsat,
      label: 'Leftover (not printed)',
      noteUrl: noteUrlOf(run.current),
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
  onUpdate: (run: PersistedRun) => void
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
    current: {
      k1: info.k1,
      amountMsat: info.maxWithdrawable,
      callback: info.callback
    },
    pending: null,
    pendingKind: null,
    state: 'running',
    message: null,
    leftover: null
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
