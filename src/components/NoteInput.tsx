import {createSignal, Show} from 'solid-js'
import {resolveNoteInput, fetchNoteInfo} from 'lnurlcash-kit'

export type NoteBalance = {
  url: string
  maxWithdrawableMsat: number
  mintPubkey: string
  host: string
}

type Props = {
  value: string
  onChange: (value: string) => void
  onResolved: (balance: NoteBalance | null) => void
  disabled?: boolean
}

const NoteInput = (props: Props) => {
  const [checking, setChecking] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [balance, setBalance] = createSignal<NoteBalance | null>(null)

  const check = async () => {
    setError(null)
    setBalance(null)
    props.onResolved(null)
    const url = resolveNoteInput(props.value)
    if (!url) {
      setError(
        'Not a recognizable bearer note (LNURL, lnurlw://, or https:// withdraw link).'
      )
      return
    }
    setChecking(true)
    try {
      const info = await fetchNoteInfo(url)
      const result: NoteBalance = {
        url,
        maxWithdrawableMsat: info.maxWithdrawable,
        mintPubkey: info.mintPubkey,
        host: new URL(info.callback).host
      }
      setBalance(result)
      props.onResolved(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setChecking(false)
    }
  }

  return (
    <div class="field">
      <label for="note-input">Bearer note to split</label>
      <div class="row">
        <input
          id="note-input"
          type="text"
          placeholder="lnurlw://mint.example/w?k1=...&amount=..."
          value={props.value}
          disabled={props.disabled}
          onInput={e => {
            props.onChange(e.currentTarget.value)
            setBalance(null)
            setError(null)
          }}
        />
        <button
          type="button"
          disabled={props.disabled || checking() || !props.value.trim()}
          onClick={check}
        >
          {checking() ? 'Checking…' : 'Check'}
        </button>
      </div>
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
      <Show when={balance()}>
        {b => (
          <p class="hint">
            {Math.floor(b().maxWithdrawableMsat / 1000).toLocaleString()} sat
            available at <code>{b().host}</code>
          </p>
        )}
      </Show>
    </div>
  )
}

export default NoteInput
