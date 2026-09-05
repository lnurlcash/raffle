import {createSignal, Show} from 'solid-js'
import {hasUnresolvedFunds, type PersistedRun} from '../lib/storage'

type Props = {
  run: PersistedRun
  onResume: () => void
  onDiscard: () => void
}

const ResumeBanner = (props: Props) => {
  const [confirmingDiscard, setConfirmingDiscard] = createSignal(false)

  return (
    <div class="banner warn resume-banner">
      <p>
        Found an unfinished lottery run ({props.run.tickets.length} of{' '}
        {props.run.plan.length} tickets minted, from{' '}
        {new Date(props.run.createdAt).toLocaleString()}).
      </p>
      <div class="row">
        <button type="button" onClick={props.onResume}>
          Resume
        </button>
        <Show
          when={!confirmingDiscard()}
          fallback={
            <>
              <span class="hint">
                {hasUnresolvedFunds(props.run)
                  ? 'This may forfeit real, possibly-spent sats. '
                  : ''}
                Click again to confirm:
              </span>
              <button type="button" class="danger" onClick={props.onDiscard}>
                Yes, discard
              </button>
              <button
                type="button"
                class="ghost"
                onClick={() => setConfirmingDiscard(false)}
              >
                Cancel
              </button>
            </>
          }
        >
          <button
            type="button"
            class="ghost"
            onClick={() => setConfirmingDiscard(true)}
          >
            Discard
          </button>
        </Show>
      </div>
    </div>
  )
}

export default ResumeBanner
