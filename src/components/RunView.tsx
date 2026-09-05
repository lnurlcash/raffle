import {For, Show} from 'solid-js'
import type {PersistedRun} from '../lib/storage'

type Props = {
  run: PersistedRun
  onRetry: () => void
  onDownload: () => void
  onDownloadCsv: () => void
  onStartNew: () => void
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

  return (
    <div class="run-view">
      <p class="progress">
        {done()} / {total()} tickets minted
      </p>
      <progress max={total()} value={done()} />

      <Show when={props.run.state === 'needs-check'}>
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

      <Show when={props.run.state === 'error'}>
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

      <Show when={props.run.state === 'done'}>
        <div class="banner success">
          <p>All tickets minted.</p>
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
                Leftover (mint fees / unallocated):{' '}
                {Math.floor(leftover().amountMsat / 1000).toLocaleString()} sat
                — not printed, this bearer note is yours to keep or
                redistribute:
              </p>
              <code class="note-url">{leftover().noteUrl}</code>
            </div>
          )}
        </Show>
        <button type="button" class="ghost" onClick={props.onStartNew}>
          Start a new lottery
        </button>
      </Show>

      <table class="tickets">
        <thead>
          <tr>
            <th>#</th>
            <th>Sat</th>
            <th>Label</th>
            <th>Note</th>
            <th>Signed</th>
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
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  )
}

export default RunView
