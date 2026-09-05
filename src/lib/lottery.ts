// A lottery is a prize table (tiers of "this many tickets are worth this
// much") expanded into one bearer-note amount per physical ticket, then
// shuffled so a ticket's position on the printed sheet gives no hint of its
// value - the whole point of a raffle strip.

export type PaperSize = 'a4' | 'letter'

export type PrizeTier = {
  id: string
  count: number
  amountSat: number
  label: string
}

export type LotteryConfig = {
  title: string
  tiers: PrizeTier[]
  // false = "mystery" tickets: the printed strip omits the sat amount, so
  // holders learn what they won only by scanning/redeeming
  showAmount: boolean
  paper: PaperSize
  // what a ticket is sold to a participant for - purely informational (see
  // grossRevenueSat/haircutSat below). Never touches the split: the prize
  // pool is whatever bearer note the organizer already holds, this only
  // helps them price tickets against it. 0 means "not selling tickets" (a
  // gift lottery), and the haircut calculation is hidden.
  ticketPriceSat: number
}

export const emptyTier = (): PrizeTier => ({
  id: crypto.randomUUID(),
  count: 1,
  amountSat: 1000,
  label: ''
})

export const defaultConfig = (): LotteryConfig => ({
  title: 'Lottery',
  tiers: [emptyTier()],
  showAmount: true,
  paper: 'a4',
  ticketPriceSat: 0
})

// Ready-made tier shapes an organizer can start from instead of building one
// ticket at a time. Each preset replaces the whole tier list - the counts
// and amounts are starting points to edit, not fixed to any total.
export type TierPreset = {
  id: string
  name: string
  description: string
  build: () => PrizeTier[]
}

const tier = (count: number, amountSat: number, label = ''): PrizeTier => ({
  ...emptyTier(),
  count,
  amountSat,
  label
})

export const TIER_PRESETS: TierPreset[] = [
  {
    id: 'single-winner',
    name: 'Single winner',
    description: 'One grand prize, everyone else gets a small consolation.',
    build: () => [tier(1, 100000, 'Grand prize'), tier(49, 100)]
  },
  {
    id: 'classic-raffle',
    name: 'Classic raffle',
    description:
      'A grand prize, a few runner-ups, and a broad consolation tier.',
    build: () => [
      tier(1, 100000, 'Grand prize'),
      tier(3, 10000, 'Runner-up'),
      tier(46, 500)
    ]
  },
  {
    id: 'pyramid',
    name: 'Prize pyramid',
    description: 'A big top prize over a wider middle tier and a broad base.',
    build: () => [
      tier(1, 200000, 'Grand prize'),
      tier(5, 20000, 'Runner-up'),
      tier(20, 2000),
      tier(74, 200)
    ]
  },
  {
    id: 'even-split',
    name: 'Even split',
    description: 'Every ticket is worth exactly the same amount.',
    build: () => [tier(50, 1000)]
  }
]

export const ticketCount = (config: LotteryConfig): number =>
  config.tiers.reduce((n, t) => n + Math.max(0, Math.floor(t.count)), 0)

export const totalAmountSat = (config: LotteryConfig): number =>
  config.tiers.reduce(
    (n, t) => n + Math.max(0, Math.floor(t.count)) * Math.max(0, t.amountSat),
    0
  )

export const totalAmountMsat = (config: LotteryConfig): number =>
  totalAmountSat(config) * 1000

// What selling every ticket at the configured price would bring in - not
// what the split actually moves, which comes entirely from the note the
// organizer already holds.
export const grossRevenueSat = (config: LotteryConfig): number =>
  Math.max(0, Math.floor(config.ticketPriceSat)) * ticketCount(config)

// Revenue minus what gets paid back out in prizes if every ticket sells -
// the organizer's take. Negative means the prize pool costs more than ticket
// sales cover, i.e. the organizer is subsidizing the lottery.
export const haircutSat = (config: LotteryConfig): number =>
  grossRevenueSat(config) - totalAmountSat(config)

// null when there's no ticket price set to divide by (a free/gift lottery),
// rather than a misleading 0%/Infinity.
export const haircutPercent = (config: LotteryConfig): number | null => {
  const revenue = grossRevenueSat(config)
  if (revenue <= 0) return null
  return (haircutSat(config) / revenue) * 100
}

// The inverse of haircutPercent: given a target margin, what a ticket needs
// to sell for so that revenue - payout = revenue * percent/100. Solving for
// revenue: revenue = payout / (1 - percent/100). Rounds up (never down) so
// the achieved margin is at least the target, never a hair under it.
// null when the target is unsatisfiable at any price (>=100%, which would
// require an infinite or negative revenue) or there are no tickets to
// spread the price across.
export const ticketPriceForHaircutPercent = (
  config: LotteryConfig,
  percent: number
): number | null => {
  const count = ticketCount(config)
  if (count <= 0 || !Number.isFinite(percent) || percent >= 100) return null
  const payout = totalAmountSat(config)
  const revenue = payout / (1 - percent / 100)
  return Math.max(0, Math.ceil(revenue / count))
}

// above this, a single run means this many split round-trips to the mint -
// still works, just slow and easy to fat-finger. A soft ceiling, not a hard
// one: validateConfig only warns.
export const MANY_TICKETS_WARNING = 300

export type TicketPlan = {
  index: number
  amountMsat: number
  label: string
}

// Fisher-Yates using a CSPRNG - Math.random's bias would leak which tier a
// position was drawn from over enough lotteries, defeating the shuffle's
// only purpose
const secureShuffle = <T>(items: T[]): T[] => {
  const arr = items.slice()
  for (let i = arr.length - 1; i > 0; i--) {
    const bytes = crypto.getRandomValues(new Uint32Array(1))
    const j = bytes[0]! % (i + 1)
    ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
  }
  return arr
}

export const planTickets = (config: LotteryConfig): TicketPlan[] => {
  const flat: Omit<TicketPlan, 'index'>[] = []
  for (const tier of config.tiers) {
    const count = Math.max(0, Math.floor(tier.count))
    const amountMsat = Math.max(0, Math.floor(tier.amountSat)) * 1000
    for (let i = 0; i < count; i++) {
      flat.push({amountMsat, label: tier.label.trim()})
    }
  }
  return secureShuffle(flat).map((t, index) => ({...t, index}))
}

export const validateConfig = (
  config: LotteryConfig,
  availableMsat: number | null
): string | null => {
  if (!config.title.trim()) return 'Give the lottery a title.'
  if (config.tiers.length === 0) return 'Add at least one prize tier.'
  for (const tier of config.tiers) {
    if (!Number.isFinite(tier.count) || tier.count < 1) {
      return 'Every tier needs at least 1 ticket.'
    }
    if (!Number.isFinite(tier.amountSat) || tier.amountSat < 1) {
      return 'Every tier needs a positive sat amount.'
    }
  }
  const total = ticketCount(config)
  if (total < 1) return 'Configure at least one ticket.'
  if (availableMsat !== null && totalAmountMsat(config) > availableMsat) {
    return (
      `Prize total is ${totalAmountSat(config).toLocaleString()} sat, ` +
      `but the note only carries ${Math.floor(availableMsat / 1000).toLocaleString()} sat.`
    )
  }
  return null
}
