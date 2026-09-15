import {createSignal, For, Show} from 'solid-js'
import {toBech32Lnurl} from '@lnurlcash/kit'
import {
  hasUnresolvedFunds,
  type PersistedRun,
  type TicketRecord
} from '../lib/storage'
import DangerZone from './DangerZone'

type Props = {
  run: PersistedRun
  onRetry: () => void
  onDownload: () => void
  onDownloadCsv: () => void
  onForget: () => void
  onRotate: (index: number) => Promise<void>
  retrying: boolean
}

const shortNote = (url: string): string => {
  try {
    const k1 = new URL(url).searchParams.get('k1') ?? ''
    return k1.slice(0, 8) + '…'
  } catch {
    return url.slice(0, 16) + '…'
  }
}

const RunView = (props: Props) => {
  const total = () => props.run.plan.length
  const done = () => props.run.tickets.length
  // every planned ticket minted is what actually matters for whether the
  // download/export actions should be available - trusting `state` alone
  // for that gates real, already-minted money behind one string staying in
  // sync with reality, which is a fragile thing to make the only way out
  const allMinted = () => done() >= total() && total() > 0
  const [confirmingForget, setConfirmingForget] = createSignal(false)
  const [copiedIndex, setCopiedIndex] = createSignal<number | null>(null)
  const [confirmingRotate, setConfirmingRotate] = createSignal<number | null>(
    null
  )
  const [rotatingIndex, setRotatingIndex] = createSignal<number | null>(null)
  const [rotateError, setRotateError] = createSignal<string | null>(null)

  const copyTicket = async (index: number, noteUrl: string) => {
    await navigator.clipboard.writeText(toBech32Lnurl(noteUrl))
    setCopiedIndex(index)
    setTimeout(() => setCopiedIndex(null), 2000)
  }

  const rotateTicket = async (index: number) => {
    setConfirmingRotate(null)
    setRotatingIndex(index)
    setRotateError(null)
    try {
      await props.onRotate(index)
    } catch (err) {
      setRotateError(err instanceof Error ? err.message : String(err))
    } finally {
      setRotatingIndex(null)
    }
  }

  const rotateCell = (index: number) => (
    <td>
      <Show
        when={confirmingRotate() !== index}
        fallback={
          <button
            type="button"
            class="danger"
            title="Burns the note currently printed for this ticket and mints a fresh one - confirm"
            onClick={() => rotateTicket(index)}
          >
            Sure?
          </button>
        }
      >
        <button
          type="button"
          class="ghost"
          disabled={rotatingIndex() !== null}
          title="Rotate: refresh this note's confirmed value and signature (burns the printed one)"
          onClick={() => setConfirmingRotate(index)}
        >
          {rotatingIndex() === index ? '…' : '↻'}
        </button>
      </Show>
    </td>
  )

  const dangerZoneTickets = (): TicketRecord[] =>
    props.run.leftover
      ? [...props.run.tickets, props.run.leftover]
      : props.run.tickets

  return (
    <div class="run-view">
      <p class="progress">
        {done()} / {total()} tickets minted
      </p>
      <progress max={total()} value={done()} />

      <Show when={props.run.state === 'needs-check' && !allMinted()}>
        <div class="banner warn">
          <p>{props.run.message}</p>
          <button
            type="button"
            disabled={props.retrying}
            onClick={props.onRetry}
          >
            {props.retrying ? 'Checking…' : 'Check pending'}
          </button>
        </div>
      </Show>

      <Show when={props.run.state === 'error' && !allMinted()}>
        <div class="banner error">
          <p>{props.run.message}</p>
          <button
            type="button"
            disabled={props.retrying}
            onClick={props.onRetry}
          >
            {props.retrying ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      </Show>

      <Show when={allMinted()}>
        <div class="banner success">
          <p>All tickets minted.</p>
          <Show when={props.run.message}>
            <p class="hint">{props.run.message}</p>
          </Show>
          <div class="row">
            <button type="button" onClick={props.onDownload}>
              Download print PDF
            </button>
            <button type="button" class="ghost" onClick={props.onDownloadCsv}>
              Download ticket manifest (CSV)
            </button>
          </div>
        </div>
        <Show when={props.run.leftover}>
          {leftover => (
            <div class="leftover">
              <p>
                Leftover:{' '}
                {Math.floor(leftover().amountMsat / 1000).toLocaleString()} sat
                — not printed, this bearer note is yours to keep or
                redistribute:
              </p>
              <code class="note-url">{toBech32Lnurl(leftover().noteUrl)}</code>
              <div class="row">
                <button
                  type="button"
                  class="ghost"
                  onClick={() => copyTicket(-1, leftover().noteUrl)}
                >
                  {copiedIndex() === -1 ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
          )}
        </Show>
        <p class="hint">
          {props.run.feesMsat === null
            ? "Mint fees charged: couldn't be confirmed (the closing balance check failed - nothing lost, just unconfirmed)."
            : props.run.feesMsat > 0
              ? `Mint fees charged across this run: ${Math.floor(props.run.feesMsat / 1000).toLocaleString()} sat.`
              : 'No mint fees were charged for this run.'}
        </p>
      </Show>

      <div class="row">
        <Show
          when={!confirmingForget()}
          fallback={
            <>
              <span class="hint">
                {hasUnresolvedFunds(props.run)
                  ? 'This may forfeit real, possibly-spent sats. '
                  : ''}
                Click again to confirm:
              </span>
              <button
                type="button"
                class="danger"
                onClick={() => {
                  setConfirmingForget(false)
                  props.onForget()
                }}
              >
                Yes, forget it
              </button>
              <button
                type="button"
                class="ghost"
                onClick={() => setConfirmingForget(false)}
              >
                Cancel
              </button>
            </>
          }
        >
          <button
            type="button"
            class="ghost"
            onClick={() => setConfirmingForget(true)}
          >
            {allMinted() ? 'Start a new lottery' : 'Forget this raffle'}
          </button>
        </Show>
      </div>

      <Show when={rotateError()}>
        <p class="error">{rotateError()}</p>
      </Show>

      <table class="tickets">
        <thead>
          <tr>
            <th>#</th>
            <th>Sat</th>
            <th>Label</th>
            <th>Note</th>
            <th>Signed</th>
            <th />
            <th />
          </tr>
        </thead>
        <tbody>
          <For each={[...props.run.tickets].sort((a, b) => a.index - b.index)}>
            {ticket => (
              <tr>
                <td>{ticket.index + 1}</td>
                <td>{Math.floor(ticket.amountMsat / 1000).toLocaleString()}</td>
                <td>{ticket.label}</td>
                <td>
                  <code>{shortNote(ticket.noteUrl)}</code>
                </td>
                <td>{ticket.verified ? '✓' : '—'}</td>
                <td>
                  <button
                    type="button"
                    class="ghost"
                    onClick={() => copyTicket(ticket.index, ticket.noteUrl)}
                  >
                    {copiedIndex() === ticket.index ? 'Copied!' : 'Copy'}
                  </button>
                </td>
                {rotateCell(ticket.index)}
              </tr>
            )}
          </For>
          <Show when={props.run.leftover}>
            {leftover => (
              <tr>
                <td>—</td>
                <td>
                  {Math.floor(leftover().amountMsat / 1000).toLocaleString()}
                </td>
                <td>Leftover (not printed)</td>
                <td>
                  <code>{shortNote(leftover().noteUrl)}</code>
                </td>
                <td>{leftover().verified ? '✓' : '—'}</td>
                <td>
                  <button
                    type="button"
                    class="ghost"
                    onClick={() => copyTicket(-1, leftover().noteUrl)}
                  >
                    {copiedIndex() === -1 ? 'Copied!' : 'Copy'}
                  </button>
                </td>
                {rotateCell(-1)}
              </tr>
            )}
          </Show>
        </tbody>
      </table>

      <Show when={allMinted()}>
        <DangerZone tickets={dangerZoneTickets()} />
      </Show>
    </div>
  )
}

export default RunView
