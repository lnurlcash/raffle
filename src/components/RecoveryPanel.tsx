import {createSignal, For, Show} from 'solid-js'
import {buildNoteUrl, type CashNode} from 'lnurlcash-kit'
import {
  scanForNotes,
  type RecoveredNote,
  type ScanProgress
} from '../lib/recovery'

type Props = {
  cashRoot: CashNode
}

const RecoveryPanel = (props: Props) => {
  const [mintUrl, setMintUrl] = createSignal('')
  const [scanning, setScanning] = createSignal(false)
  const [progress, setProgress] = createSignal<ScanProgress | null>(null)
  const [results, setResults] = createSignal<RecoveredNote[] | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  const scan = async () => {
    setScanning(true)
    setError(null)
    setResults(null)
    setProgress(null)
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
          Checking index {progress()!.index}… {progress()!.foundCount} found so
          far.
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
          </Show>
        )}
      </Show>
    </div>
  )
}

export default RecoveryPanel
