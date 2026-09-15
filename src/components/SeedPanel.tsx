import {createSignal, Show} from 'solid-js'
import {
  generateSeedPhrase,
  isValidSeedPhrase,
  cashRootFromPhrase,
  clearCashRoot,
  type CashRoot
} from '../lib/seed'

type Mode = 'idle' | 'generate' | 'restore'

type Props = {
  active: boolean
  onActivate: (root: CashRoot) => void
  onForget: () => void
}

const SeedPanel = (props: Props) => {
  const [mode, setMode] = createSignal<Mode>('idle')
  const [phrase, setPhrase] = createSignal('')
  const [saved, setSaved] = createSignal(false)
  const [restoreInput, setRestoreInput] = createSignal('')
  const [restoreError, setRestoreError] = createSignal<string | null>(null)
  const [confirmingForget, setConfirmingForget] = createSignal(false)

  const startGenerate = () => {
    setPhrase(generateSeedPhrase())
    setSaved(false)
    setMode('generate')
  }

  const confirmGenerated = () => {
    props.onActivate(cashRootFromPhrase(phrase()))
    setPhrase('')
    setSaved(false)
    setMode('idle')
  }

  const submitRestore = () => {
    const trimmed = restoreInput().trim().toLowerCase()
    if (!isValidSeedPhrase(trimmed)) {
      setRestoreError('That is not a valid 12-word BIP39 seed phrase.')
      return
    }
    props.onActivate(cashRootFromPhrase(trimmed))
    setRestoreInput('')
    setRestoreError(null)
    setMode('idle')
  }

  const forget = () => {
    clearCashRoot()
    props.onForget()
    setConfirmingForget(false)
  }

  return (
    <div class="config-form">
      <div class="field">
        <label>Seed-recoverable secrets (optional)</label>
        <p class="hint">
          With a seed active, every ticket's secret is derived from it instead
          of drawn at random - if this device's storage is ever lost, the
          tickets can be found again from the phrase alone (see "Recover
          tickets" once a raffle is split). Without one, tickets are still safe,
          just not recoverable this way.
        </p>
      </div>

      <Show when={!props.active && mode() === 'idle'}>
        <div class="row">
          <button type="button" onClick={startGenerate}>
            Generate a new seed
          </button>
          <button
            type="button"
            class="ghost"
            onClick={() => setMode('restore')}
          >
            Restore an existing seed
          </button>
        </div>
      </Show>

      <Show when={mode() === 'generate'}>
        <div class="banner warn">
          <p>
            Your seed phrase - write it down somewhere safe. It is never stored
            anywhere by this app, only shown once, right now:
          </p>
          <code class="note-url">{phrase()}</code>
          <label class="checkbox">
            <input
              type="checkbox"
              checked={saved()}
              onChange={e => setSaved(e.currentTarget.checked)}
            />
            I have written this seed phrase down somewhere safe
          </label>
          <div class="row">
            <button
              type="button"
              disabled={!saved()}
              onClick={confirmGenerated}
            >
              Activate this seed
            </button>
            <button
              type="button"
              class="ghost"
              onClick={() => {
                setPhrase('')
                setMode('idle')
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      </Show>

      <Show when={mode() === 'restore'}>
        <div class="field">
          <label for="restore-phrase">Your 12-word seed phrase</label>
          <textarea
            id="restore-phrase"
            rows="2"
            value={restoreInput()}
            onInput={e => {
              setRestoreInput(e.currentTarget.value)
              setRestoreError(null)
            }}
          />
          <Show when={restoreError()}>
            <p class="error">{restoreError()}</p>
          </Show>
          <div class="row">
            <button type="button" onClick={submitRestore}>
              Restore
            </button>
            <button
              type="button"
              class="ghost"
              onClick={() => {
                setRestoreInput('')
                setRestoreError(null)
                setMode('idle')
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      </Show>

      <Show when={props.active}>
        <div class="row">
          <span class="hint">Seed active.</span>
          <Show
            when={!confirmingForget()}
            fallback={
              <>
                <span class="hint">
                  This only forgets it on this device - already-minted tickets
                  are unaffected. Click again to confirm:
                </span>
                <button type="button" class="danger" onClick={forget}>
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
              Forget seed
            </button>
          </Show>
        </div>
      </Show>
    </div>
  )
}

export default SeedPanel
