import {createSignal, Show} from 'solid-js'
import NoteInput, {type NoteBalance} from './components/NoteInput'
import ConfigForm from './components/ConfigForm'
import RunView from './components/RunView'
import ResumeBanner from './components/ResumeBanner'
import {defaultConfig, validateConfig, ticketCount} from './lib/lottery'
import {loadRun, saveRun, clearRun, type PersistedRun} from './lib/storage'
import {startRun, resumeRun} from './lib/run'
import {generateLotteryPdf, previewTickets} from './lib/pdf'
import {ticketsToCsv} from './lib/csv'

const App = () => {
  const [run, setRun] = createSignal<PersistedRun | null>(loadRun())
  // true once the user has taken an action to drive the current run forward
  // in this session (started it, or resumed/retried a loaded one) - gates
  // whether the "found an unfinished run" banner or the live progress view
  // is what's shown for it
  const [touched, setTouched] = createSignal(false)

  const [noteValue, setNoteValue] = createSignal('')
  const [balance, setBalance] = createSignal<NoteBalance | null>(null)
  const [config, setConfig] = createSignal(defaultConfig())
  const [confirming, setConfirming] = createSignal(false)
  const [starting, setStarting] = createSignal(false)
  const [startError, setStartError] = createSignal<string | null>(null)
  const [retrying, setRetrying] = createSignal(false)

  const validationError = () =>
    validateConfig(config(), balance()?.maxWithdrawableMsat ?? null)
  // the preview needs no note at all, so it's gated on tier structure only -
  // never the balance check that (correctly) blocks the real split
  const previewError = () => validateConfig(config(), null)

  const beginSplit = async () => {
    if (!confirming()) {
      setConfirming(true)
      return
    }
    setStarting(true)
    setStartError(null)
    setTouched(true)
    try {
      await startRun(noteValue(), config(), setRun)
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
      setConfirming(false)
    }
  }

  const retry = async () => {
    const current = run()
    if (!current) return
    setRetrying(true)
    try {
      await resumeRun(current, setRun)
    } finally {
      setRetrying(false)
    }
  }

  const resumeFromBanner = async () => {
    const current = run()
    if (!current) return
    setTouched(true)
    setRetrying(true)
    try {
      await resumeRun(current, setRun)
    } finally {
      setRetrying(false)
    }
  }

  const discardFromBanner = () => {
    clearRun()
    setRun(null)
  }

  const triggerDownload = (data: BlobPart, filename: string, mime: string) => {
    const blob = new Blob([data], {type: mime})
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  const download = async () => {
    const current = run()
    if (!current) return
    const bytes = await generateLotteryPdf(current.config, current.tickets)
    triggerDownload(
      bytes as unknown as BlobPart,
      `${current.config.title.trim() || 'lottery'}.pdf`,
      'application/pdf'
    )
  }

  const downloadCsv = () => {
    const current = run()
    if (!current) return
    const csv = ticketsToCsv(current.tickets, current.leftover)
    triggerDownload(
      csv,
      `${current.config.title.trim() || 'lottery'}-tickets.csv`,
      'text/csv'
    )
  }

  const downloadPreview = async () => {
    const bytes = await generateLotteryPdf(config(), previewTickets(config()), {
      preview: true
    })
    triggerDownload(
      bytes as unknown as BlobPart,
      `${config().title.trim() || 'lottery'}-preview.pdf`,
      'application/pdf'
    )
  }

  const startNew = () => {
    clearRun()
    setRun(null)
    setNoteValue('')
    setBalance(null)
    setConfig(defaultConfig())
    setConfirming(false)
    setStartError(null)
    setTouched(false)
  }

  return (
    <main>
      <h1>LNURLcash Raffle</h1>
      <p class="tagline">
        Split one bearer note into many, print them as cut-and-roll tickets.
      </p>

      <Show when={run() && run()!.state !== 'done' && !touched()}>
        <ResumeBanner
          run={run()!}
          onResume={resumeFromBanner}
          onDiscard={discardFromBanner}
        />
      </Show>

      <Show when={!run()}>
        <section>
          <NoteInput
            value={noteValue()}
            onChange={setNoteValue}
            onResolved={setBalance}
            disabled={starting()}
          />
          <ConfigForm
            config={config()}
            onChange={setConfig}
            disabled={starting()}
          />

          <div class="row">
            <button
              type="button"
              class="ghost"
              disabled={!!previewError() || starting()}
              onClick={downloadPreview}
            >
              Preview PDF
            </button>
            <span class="hint">
              No note needed - checks the layout, not the funds.
            </span>
          </div>

          <Show when={validationError()}>
            <p class="error">{validationError()}</p>
          </Show>
          <Show when={startError()}>
            <p class="error">{startError()}</p>
          </Show>

          <Show
            when={!confirming()}
            fallback={
              <div class="banner warn">
                <p>
                  This will burn the note above and mint {ticketCount(config())}{' '}
                  new bearer notes at the mint. This cannot be undone. Continue?
                </p>
                <div class="row">
                  <button
                    type="button"
                    disabled={starting()}
                    onClick={beginSplit}
                  >
                    {starting() ? 'Splitting…' : 'Yes, split the note'}
                  </button>
                  <button
                    type="button"
                    class="ghost"
                    disabled={starting()}
                    onClick={() => setConfirming(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            }
          >
            <button
              type="button"
              disabled={!balance() || !!validationError() || starting()}
              onClick={beginSplit}
            >
              Split into tickets
            </button>
          </Show>
        </section>
      </Show>

      <Show when={run() && (run()!.state === 'done' || touched())}>
        <RunView
          run={run()!}
          onRetry={retry}
          onDownload={download}
          onDownloadCsv={downloadCsv}
          onStartNew={startNew}
          retrying={retrying()}
        />
      </Show>
    </main>
  )
}

export default App
