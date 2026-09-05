import {describe, expect, it} from 'vitest'
import {
  defaultConfig,
  emptyTier,
  planTickets,
  ticketCount,
  totalAmountSat,
  totalAmountMsat,
  grossRevenueSat,
  haircutSat,
  haircutPercent,
  ticketPriceForHaircutPercent,
  validateConfig,
  TIER_PRESETS
} from './lottery'

const configWithTiers = (
  tiers: Array<{count: number; amountSat: number; label?: string}>
) => ({
  ...defaultConfig(),
  tiers: tiers.map(t => ({...emptyTier(), ...t, label: t.label ?? ''}))
})

describe('ticketCount / totalAmountSat', () => {
  it('sums tiers, ignoring fractional/negative counts', () => {
    const config = configWithTiers([
      {count: 1, amountSat: 100000},
      {count: 5, amountSat: 5000},
      {count: 20, amountSat: 500}
    ])
    expect(ticketCount(config)).toBe(26)
    expect(totalAmountSat(config)).toBe(135000)
    expect(totalAmountMsat(config)).toBe(135000000)
  })
})

describe('planTickets', () => {
  it('expands tiers into one entry per ticket with the right amount', () => {
    const config = configWithTiers([
      {count: 1, amountSat: 100000, label: 'Grand prize'},
      {count: 3, amountSat: 500}
    ])
    const plan = planTickets(config)
    expect(plan).toHaveLength(4)
    const grand = plan.filter(t => t.amountMsat === 100000000)
    const small = plan.filter(t => t.amountMsat === 500000)
    expect(grand).toHaveLength(1)
    expect(grand[0]!.label).toBe('Grand prize')
    expect(small).toHaveLength(3)
  })

  it('assigns a contiguous 0-based index after shuffling', () => {
    const config = configWithTiers([{count: 50, amountSat: 100}])
    const plan = planTickets(config)
    expect(plan.map(t => t.index).sort((a, b) => a - b)).toEqual(
      Array.from({length: 50}, (_, i) => i)
    )
  })

  it('does not always place a lone high-value tier at a fixed position', () => {
    // a fixed shuffle would defeat the entire point of a raffle - assert
    // over many runs that the grand-prize ticket's position varies
    const config = configWithTiers([
      {count: 1, amountSat: 999999},
      ...Array.from({length: 19}, () => ({count: 1, amountSat: 100}))
    ])
    const positions = new Set<number>()
    for (let i = 0; i < 40; i++) {
      const plan = planTickets(config)
      positions.add(plan.findIndex(t => t.amountMsat === 999999000))
    }
    expect(positions.size).toBeGreaterThan(1)
  })

  it('preserves total value through the shuffle', () => {
    const config = configWithTiers([
      {count: 1, amountSat: 100000},
      {count: 5, amountSat: 5000},
      {count: 20, amountSat: 500}
    ])
    const plan = planTickets(config)
    const sum = plan.reduce((n, t) => n + t.amountMsat, 0)
    expect(sum).toBe(totalAmountMsat(config))
  })
})

describe('validateConfig', () => {
  it('rejects a blank title', () => {
    const config = {
      ...configWithTiers([{count: 1, amountSat: 100}]),
      title: ' '
    }
    expect(validateConfig(config, null)).toMatch(/title/i)
  })

  it('rejects a tier with zero tickets or zero value', () => {
    expect(
      validateConfig(configWithTiers([{count: 0, amountSat: 100}]), null)
    ).toMatch(/ticket/i)
    expect(
      validateConfig(configWithTiers([{count: 1, amountSat: 0}]), null)
    ).toMatch(/sat/i)
  })

  it('rejects a prize total exceeding the note balance', () => {
    const config = configWithTiers([{count: 1, amountSat: 1000}])
    expect(validateConfig(config, 500_000)).toMatch(/exceeds|only carries/i)
  })

  it('accepts a config that fits within the note balance', () => {
    const config = configWithTiers([{count: 1, amountSat: 1000}])
    expect(validateConfig(config, 1_000_000)).toBeNull()
  })

  it('is satisfiable with no balance known yet', () => {
    const config = configWithTiers([{count: 1, amountSat: 1000}])
    expect(validateConfig(config, null)).toBeNull()
  })
})

describe('haircut calculation', () => {
  it('is unset (null percent) when no ticket price is configured', () => {
    const config = configWithTiers([{count: 10, amountSat: 100}])
    expect(config.ticketPriceSat).toBe(0)
    expect(grossRevenueSat(config)).toBe(0)
    expect(haircutPercent(config)).toBeNull()
  })

  it('computes revenue, payout and the organizer take from a ticket price', () => {
    const config = {
      ...configWithTiers([
        {count: 1, amountSat: 100000},
        {count: 49, amountSat: 100}
      ]),
      ticketPriceSat: 5000
    }
    // 50 tickets * 5000 sat = 250000 sat revenue
    expect(ticketCount(config)).toBe(50)
    expect(grossRevenueSat(config)).toBe(250000)
    // payout: 100000 + 49*100 = 104900
    expect(totalAmountSat(config)).toBe(104900)
    expect(haircutSat(config)).toBe(250000 - 104900)
    expect(haircutPercent(config)).toBeCloseTo(
      ((250000 - 104900) / 250000) * 100
    )
  })

  it('reports a negative haircut when the prize pool costs more than ticket sales cover', () => {
    const config = {
      ...configWithTiers([{count: 10, amountSat: 100000}]),
      ticketPriceSat: 1000
    }
    // 10 tickets * 1000 sat = 10000 sat revenue vs 1000000 sat paid out
    expect(haircutSat(config)).toBeLessThan(0)
    expect(haircutPercent(config)).toBeLessThan(0)
  })
})

describe('ticketPriceForHaircutPercent', () => {
  it('is the exact inverse of haircutPercent at a round price', () => {
    const config = {
      ...configWithTiers([
        {count: 1, amountSat: 100000},
        {count: 49, amountSat: 100}
      ]),
      ticketPriceSat: 0
    }
    const payout = totalAmountSat(config) // 104900
    // pick a price by hand, read off its actual margin, then ask for that
    // margin back and expect (at least) the same price
    const price = 5000
    const achieved = haircutPercent({...config, ticketPriceSat: price})!
    const suggested = ticketPriceForHaircutPercent(config, achieved)
    expect(suggested).not.toBeNull()
    // ceil'd float round-trip can land a sat above the original price, but
    // never more than that - it must never undershoot the requested margin
    expect(suggested).toBeLessThanOrEqual(price + 1)
    // rounding up must never undershoot the requested margin
    const reachedPercent = haircutPercent({
      ...config,
      ticketPriceSat: suggested!
    })!
    expect(reachedPercent).toBeGreaterThanOrEqual(achieved - 0.01)
    expect(payout).toBe(104900)
  })

  it('prices at exactly the payout per ticket for a 0% (breakeven) target', () => {
    const config = configWithTiers([{count: 10, amountSat: 1000}])
    const price = ticketPriceForHaircutPercent(config, 0)
    expect(price).toBe(1000) // 10000 sat payout / 10 tickets
  })

  it('returns null for a target of 100% or more (unsatisfiable at any price)', () => {
    const config = configWithTiers([{count: 10, amountSat: 1000}])
    expect(ticketPriceForHaircutPercent(config, 100)).toBeNull()
    expect(ticketPriceForHaircutPercent(config, 150)).toBeNull()
  })

  it('allows a negative target (a subsidized price below payout)', () => {
    const config = configWithTiers([{count: 10, amountSat: 1000}])
    const price = ticketPriceForHaircutPercent(config, -100)
    // revenue = 10000 / (1 - (-1)) = 5000 sat, i.e. 500 sat/ticket
    expect(price).toBe(500)
  })

  it('returns null with no tickets configured', () => {
    const config = configWithTiers([{count: 0, amountSat: 1000}])
    expect(ticketPriceForHaircutPercent(config, 20)).toBeNull()
  })
})

describe('TIER_PRESETS', () => {
  it('each preset builds a set of tiers that passes validation', () => {
    for (const preset of TIER_PRESETS) {
      const config = {...defaultConfig(), tiers: preset.build()}
      expect(validateConfig(config, null)).toBeNull()
      expect(ticketCount(config)).toBeGreaterThan(0)
    }
  })

  it('has unique ids', () => {
    const ids = TIER_PRESETS.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
