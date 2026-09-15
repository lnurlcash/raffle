import {createSignal, For, Show} from 'solid-js'
import {buildNoteUrl} from '@lnurlcash/kit'
import {
  combineNotes,
  scanForNotes,
  type CombinedNote,
  type RecoveredNote,
  type ScanProgress
} from '../lib/recovery'
import type {CashRoot} from '../lib/seed'

type Props = {
  cashRoot: CashRoot
}

const RecoveryPanel = (props: Props) => {
  const [mintUrl, setMintUrl] = createSignal('')
  const [scanning, setScanning] = createSignal(false)
  const [progress, setProgress] = createSignal<ScanProgress | null>(null)
  const [results, setResults] = createSignal<RecoveredNote[] | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  const [confirmingCombine, setConfirmingCombine] = createSignal(false)
  const [combining, setCombining] = createSignal(false)
  const [combined, setCombined] = createSignal<CombinedNote | null>(null)
  const [combineError, setCombineError] = createSignal<string | null>(null)
  const [copied, setCopied] = createSignal(false)

  const scan = async () => {
    setScanning(true)
    setError(null)
    setResults(null)
    setProgress(null)
    setCombined(null)
    setCombineError(null)
    setConfirmingCombine(false)
    try {
      const found = await scanForNotes(
        props.cashRoot,
        mintUrl().trim(),
        setProgress
      )
      setResults(found)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setScanning(false)
    }
  }

  const totalSat = () =>
    Math.floor((results() ?? []).reduce((n, r) => n + r.amountMsat, 0) / 1000)

  const combine = async () => {
    const found = results()
    if (!found || found.length < 2) return
    setCombining(true)
    setCombineError(null)
    try {
      const result = await combineNotes(
        found[0]!.callback,
        found.map(n => n.k1)
      )
      setCombined(result)
      setResults(null)
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
    await navigator.clipboard.writeText(note.noteUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div class="config-form">
      <div class="field">
        <label for="recovery-mint">
          Recover tickets from a mint (this browser's storage lost a run's
          record, or you're restoring on a new device)
        </label>
        <div class="row">
          <input
            id="recovery-mint"
            type="text"
            placeholder="https://mint.example/w"
            value={mintUrl()}
            disabled={scanning()}
            onInput={e => setMintUrl(e.currentTarget.value)}
          />
          <button
            type="button"
            class="ghost"
            disabled={scanning() || !mintUrl().trim()}
            onClick={scan}
          >
            {scanning() ? 'Scanning…' : 'Scan'}
          </button>
        </div>
        <p class="hint">
          Walks this seed's indices at that mint until 20 in a row come back
          unknown - a note already spent looks identical to one never minted, so
          a miss just means "nothing recoverable here", not proof either way.
        </p>
      </div>

      <Show when={scanning() && progress()}>
        <p class="hint">
          Scanning… {progress()!.foundCount} found so far (last at index{' '}
          {progress()!.index}).
        </p>
      </Show>

      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>

      <Show when={results()}>
        {found => (
          <Show
            when={found().length > 0}
            fallback={<p class="hint">Nothing recoverable found there.</p>}
          >
            <p class="summary">
              Found {found().length} note{found().length === 1 ? '' : 's'},{' '}
              {totalSat().toLocaleString()} sat total.
            </p>
            <table class="tickets">
              <thead>
                <tr>
                  <th>Index</th>
                  <th>Sat</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                <For each={found()}>
                  {note => (
                    <tr>
                      <td>{note.index}</td>
                      <td>
                        {Math.floor(note.amountMsat / 1000).toLocaleString()}
                      </td>
                      <td>
                        <code class="note-url">
                          {buildNoteUrl(
                            note.callback,
                            note.k1,
                            note.amountMsat
                          )}
                        </code>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>

            <Show when={found().length > 1}>
              <Show
                when={!confirmingCombine()}
                fallback={
                  <div class="banner warn">
                    <p>
                      This will burn all {found().length} notes above and mint
                      one worth {totalSat().toLocaleString()} sat. This cannot
                      be undone. Continue?
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
                  Combine all into one note
                </button>
              </Show>
            </Show>
          </Show>
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
            <code class="note-url">{note().noteUrl}</code>
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

export default RecoveryPanel
