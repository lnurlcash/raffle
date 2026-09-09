import {createSignal, Show} from 'solid-js'
import {serverOf, toBech32Lnurl, type CashNode} from 'lnurlcash-kit'
import {
  checkTicketsLive,
  combineNotes,
  type CombinedNote,
  type TicketLiveness
} from '../lib/recovery'
import {createPersistentRandomSecret} from '../lib/seed'
import type {TicketRecord} from '../lib/storage'

type Props = {
  tickets: TicketRecord[]
  cashRoot: CashNode | null
}

const DangerZone = (props: Props) => {
  const [checking, setChecking] = createSignal(false)
  const [liveness, setLiveness] = createSignal<TicketLiveness[] | null>(null)
  const [checkError, setCheckError] = createSignal<string | null>(null)

  const [confirmingCombine, setConfirmingCombine] = createSignal(false)
  const [combining, setCombining] = createSignal(false)
  const [combined, setCombined] = createSignal<CombinedNote | null>(null)
  const [combineError, setCombineError] = createSignal<string | null>(null)
  const [copied, setCopied] = createSignal(false)

  const liveTickets = () => (liveness() ?? []).filter(l => l.live)
  const totalLiveSat = () =>
    Math.floor(liveTickets().reduce((n, l) => n + l.amountMsat, 0) / 1000)

  const check = async () => {
    setChecking(true)
    setCheckError(null)
    setLiveness(null)
    setCombined(null)
    setCombineError(null)
    setConfirmingCombine(false)
    try {
      const result = await checkTicketsLive(
        props.tickets.map(t => ({index: t.index, noteUrl: t.noteUrl}))
      )
      setLiveness(result)
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : String(err))
    } finally {
      setChecking(false)
    }
  }

  const combine = async () => {
    const live = liveTickets()
    if (live.length < 2) return
    setCombining(true)
    setCombineError(null)
    try {
      // any live ticket's own noteUrl carries the right origin/path to
      // merge against - callback is otherwise mint-wide, not per-note
      const anyTicket = props.tickets.find(t => t.index === live[0]!.index)!
      const randomSecret = props.cashRoot
        ? createPersistentRandomSecret(
            props.cashRoot,
            serverOf(anyTicket.noteUrl)
          )
        : undefined
      const result = await combineNotes(
        anyTicket.noteUrl,
        live.map(l => l.k1),
        randomSecret
      )
      setCombined(result)
      setLiveness(null)
    } catch (err) {
      setCombineError(err instanceof Error ? err.message : String(err))
    } finally {
      setCombining(false)
      setConfirmingCombine(false)
    }
  }

  const copyCombined = async () => {
    const note = combined()
    if (!note) return
    await navigator.clipboard.writeText(toBech32Lnurl(note.noteUrl))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div class="config-form">
      <div class="banner error">
        <p>
          <strong>Danger zone.</strong> These act on the tickets themselves.
          Using them on one you've already handed out or printed for someone
          else destroys its value from their side, silently - they'd hold a
          burned note, worth nothing, with no way to tell until they try to
          spend it. Only for tickets you haven't distributed yet, or are taking
          back.
        </p>
      </div>

      <div class="field">
        <button
          type="button"
          class="ghost"
          disabled={checking()}
          onClick={check}
        >
          {checking() ? 'Checking…' : 'Check which tickets are still unspent'}
        </button>
        <Show when={checkError()}>
          <p class="error">{checkError()}</p>
        </Show>
      </div>

      <Show when={liveness()}>
        {result => (
          <>
            <p class="summary">
              {liveTickets().length} of {result().length} still unspent,{' '}
              {totalLiveSat().toLocaleString()} sat total.
            </p>
            <Show when={liveTickets().length > 1}>
              <Show
                when={!confirmingCombine()}
                fallback={
                  <div class="banner warn">
                    <p>
                      This will burn all {liveTickets().length} unspent notes
                      and mint one worth {totalLiveSat().toLocaleString()} sat.
                      This cannot be undone. Continue?
                    </p>
                    <div class="row">
                      <button
                        type="button"
                        disabled={combining()}
                        onClick={combine}
                      >
                        {combining() ? 'Combining…' : 'Yes, combine them'}
                      </button>
                      <button
                        type="button"
                        class="ghost"
                        disabled={combining()}
                        onClick={() => setConfirmingCombine(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                }
              >
                <button
                  type="button"
                  class="ghost"
                  onClick={() => setConfirmingCombine(true)}
                >
                  Combine all unspent notes into one
                </button>
              </Show>
            </Show>
          </>
        )}
      </Show>

      <Show when={combineError()}>
        <p class="error">{combineError()}</p>
      </Show>

      <Show when={combined()}>
        {note => (
          <div class="leftover">
            <p>
              Combined into one note worth{' '}
              {Math.floor(note().amountMsat / 1000).toLocaleString()} sat
              {!note().verified && " (couldn't be offline-verified)"} - copy it
              into a wallet to spend it:
            </p>
            <code class="note-url">{toBech32Lnurl(note().noteUrl)}</code>
            <div class="row">
              <button type="button" class="ghost" onClick={copyCombined}>
                {copied() ? 'Copied!' : 'Copy note'}
              </button>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}

export default DangerZone
