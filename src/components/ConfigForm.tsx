import {createSignal, Index, Show} from 'solid-js'
import {
  emptyTier,
  ticketCount,
  totalAmountSat,
  grossRevenueSat,
  haircutSat,
  haircutPercent,
  ticketPriceForHaircutPercent,
  TIER_PRESETS,
  MANY_TICKETS_WARNING,
  type LotteryConfig,
  type PaperSize
} from '../lib/lottery'

type Props = {
  config: LotteryConfig
  onChange: (config: LotteryConfig) => void
  disabled?: boolean
}

const ConfigForm = (props: Props) => {
  const update = (patch: Partial<LotteryConfig>) =>
    props.onChange({...props.config, ...patch})

  const updateTier = (
    id: string,
    patch: Partial<LotteryConfig['tiers'][number]>
  ) =>
    update({
      tiers: props.config.tiers.map(t => (t.id === id ? {...t, ...patch} : t))
    })

  const removeTier = (id: string) =>
    update({tiers: props.config.tiers.filter(t => t.id !== id)})

  const addTier = () => update({tiers: [...props.config.tiers, emptyTier()]})

  const applyPreset = (id: string) => {
    const preset = TIER_PRESETS.find(p => p.id === id)
    if (preset) update({tiers: preset.build()})
  }

  // a one-way calculator, not part of LotteryConfig itself - typing here
  // never changes the ticket price on its own, "Use this price" does
  const [targetPercent, setTargetPercent] = createSignal('')
  const suggestedPrice = () => {
    if (targetPercent().trim() === '') return null
    const percent = Number(targetPercent())
    if (!Number.isFinite(percent)) return null
    return ticketPriceForHaircutPercent(props.config, percent)
  }

  return (
    <div class="config-form">
      <div class="field">
        <label for="title">Lottery title</label>
        <input
          id="title"
          type="text"
          value={props.config.title}
          disabled={props.disabled}
          onInput={e => update({title: e.currentTarget.value})}
        />
      </div>

      <div class="field">
        <label for="preset">Start from a preset</label>
        <select
          id="preset"
          value=""
          disabled={props.disabled}
          onChange={e => {
            applyPreset(e.currentTarget.value)
            e.currentTarget.value = ''
          }}
        >
          <option value="" disabled>
            Choose a preset…
          </option>
          <Index each={TIER_PRESETS}>
            {preset => (
              <option value={preset().id} title={preset().description}>
                {preset().name}
              </option>
            )}
          </Index>
        </select>
        <p class="hint">
          Replaces the tiers below with a starting point you can then edit.
        </p>
      </div>

      <div class="field">
        <label>Prize tiers</label>
        <table class="tiers">
          <thead>
            <tr>
              <th>Tickets</th>
              <th>Sat each</th>
              <th>Label (optional)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <Index each={props.config.tiers}>
              {tier => (
                <tr>
                  <td>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={tier().count}
                      disabled={props.disabled}
                      onInput={e =>
                        updateTier(tier().id, {
                          count: Number(e.currentTarget.value)
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={tier().amountSat}
                      disabled={props.disabled}
                      onInput={e =>
                        updateTier(tier().id, {
                          amountSat: Number(e.currentTarget.value)
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      placeholder="e.g. Grand prize"
                      value={tier().label}
                      disabled={props.disabled}
                      onInput={e =>
                        updateTier(tier().id, {label: e.currentTarget.value})
                      }
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      class="ghost"
                      disabled={
                        props.disabled || props.config.tiers.length <= 1
                      }
                      onClick={() => removeTier(tier().id)}
                      aria-label="Remove tier"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              )}
            </Index>
          </tbody>
        </table>
        <button
          type="button"
          class="ghost"
          disabled={props.disabled}
          onClick={addTier}
        >
          + Add tier
        </button>
      </div>

      <div class="row">
        <label class="checkbox">
          <input
            type="checkbox"
            checked={props.config.showAmount}
            disabled={props.disabled}
            onChange={e => update({showAmount: e.currentTarget.checked})}
          />
          Print the sat amount on each ticket
        </label>
      </div>

      <div class="field">
        <label for="paper">Paper size</label>
        <select
          id="paper"
          value={props.config.paper}
          disabled={props.disabled}
          onChange={e => update({paper: e.currentTarget.value as PaperSize})}
        >
          <option value="a4">A4</option>
          <option value="letter">US Letter</option>
        </select>
      </div>

      <div class="field">
        <label for="ticket-price">Ticket price (sat, optional)</label>
        <input
          id="ticket-price"
          type="number"
          min="0"
          step="1"
          value={props.config.ticketPriceSat || ''}
          placeholder="0"
          disabled={props.disabled}
          onInput={e =>
            update({ticketPriceSat: Number(e.currentTarget.value) || 0})
          }
        />
      </div>

      <div class="field">
        <label for="target-percent">Target margin % (optional)</label>
        <input
          id="target-percent"
          type="number"
          step="0.1"
          placeholder="e.g. 20"
          value={targetPercent()}
          disabled={props.disabled}
          onInput={e => setTargetPercent(e.currentTarget.value)}
        />
        <Show
          when={targetPercent().trim() !== ''}
          fallback={
            <p class="hint">
              Work out the ticket price needed for a given margin instead of the
              other way around.
            </p>
          }
        >
          <Show
            when={suggestedPrice() !== null}
            fallback={<p class="error">Target margin must be under 100%.</p>}
          >
            <p class="hint">
              To hit a {targetPercent()}% margin on {ticketCount(props.config)}{' '}
              tickets: charge {suggestedPrice()!.toLocaleString()} sat per
              ticket.{' '}
              <button
                type="button"
                class="ghost"
                disabled={props.disabled}
                onClick={() => update({ticketPriceSat: suggestedPrice()!})}
              >
                Use this price
              </button>
            </p>
          </Show>
        </Show>
      </div>

      <p class="summary">
        {ticketCount(props.config)} tickets,{' '}
        {totalAmountSat(props.config).toLocaleString()} sat total
        {ticketCount(props.config) > MANY_TICKETS_WARNING && (
          <span class="warn">
            {' '}
            — that's a lot of tickets, each one is a separate mint round-trip
          </span>
        )}
      </p>

      <Show
        when={props.config.ticketPriceSat > 0}
        fallback={
          <p class="hint">
            Set a ticket price to see your take if every ticket sells.
          </p>
        }
      >
        <p class="summary">
          If all {ticketCount(props.config)} tickets sell at{' '}
          {props.config.ticketPriceSat.toLocaleString()} sat:{' '}
          {grossRevenueSat(props.config).toLocaleString()} sat collected,{' '}
          {totalAmountSat(props.config).toLocaleString()} sat paid out —{' '}
          <span class={haircutSat(props.config) < 0 ? 'warn' : ''}>
            {haircutSat(props.config) >= 0
              ? `your take (haircut): ${haircutSat(props.config).toLocaleString()} sat (${haircutPercent(props.config)!.toFixed(1)}%)`
              : `you'd pay out ${Math.abs(haircutSat(props.config)).toLocaleString()} sat more than you collect (${haircutPercent(props.config)!.toFixed(1)}%)`}
          </span>
        </p>
      </Show>
    </div>
  )
}

export default ConfigForm
