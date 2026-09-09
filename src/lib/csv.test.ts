import {describe, expect, it} from 'vitest'
import {toBech32Lnurl} from 'lnurlcash-kit'
import {ticketsToCsv} from './csv'
import type {TicketRecord} from './storage'

const ticket = (
  index: number,
  overrides: Partial<TicketRecord> = {}
): TicketRecord => ({
  index,
  amountMsat: 500000,
  label: '',
  noteUrl: `https://mint.example/w?k1=${index}`,
  verified: true,
  ...overrides
})

describe('ticketsToCsv', () => {
  it('emits a header row plus one row per ticket, sorted by index', () => {
    const csv = ticketsToCsv([ticket(2), ticket(0), ticket(1)])
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('ticket,sat,label,signed,note')
    expect(lines[1]!.startsWith('1,')).toBe(true)
    expect(lines[2]!.startsWith('2,')).toBe(true)
    expect(lines[3]!.startsWith('3,')).toBe(true)
  })

  it('converts msat to whole sat and reports the signed flag', () => {
    const csv = ticketsToCsv([
      ticket(0, {amountMsat: 21000000, verified: true}),
      ticket(1, {amountMsat: 500000, verified: false})
    ])
    const [, row1, row2] = csv.split('\r\n')
    expect(row1).toBe(`1,21000,,yes,${toBech32Lnurl(ticket(0).noteUrl)}`)
    expect(row2).toBe(`2,500,,no,${toBech32Lnurl(ticket(1).noteUrl)}`)
  })

  it('encodes the note as bech32 (LNURL1...), not the raw URL - matching what the printed QR carries', () => {
    const csv = ticketsToCsv([ticket(0)])
    const [, row1] = csv.split('\r\n')
    const note = row1!.split(',').at(-1)!
    expect(note).toMatch(/^LNURL1/)
    expect(note).not.toContain('https://')
    expect(note).toBe(toBech32Lnurl(ticket(0).noteUrl))
  })

  it('leaves the note column blank for a ticket with no note URL', () => {
    const csv = ticketsToCsv([ticket(0, {noteUrl: ''})])
    const [, row1] = csv.split('\r\n')
    expect(row1).toBe('1,500,,yes,')
  })

  it('quotes fields containing commas or quotes, doubling embedded quotes', () => {
    const csv = ticketsToCsv([
      ticket(0, {label: 'Grand prize, 1st place'}),
      ticket(1, {label: 'the "big" one'})
    ])
    const [, row1, row2] = csv.split('\r\n')
    expect(row1).toContain('"Grand prize, 1st place"')
    expect(row2).toContain('"the ""big"" one"')
  })

  it('appends a leftover row when given one', () => {
    const leftover = ticket(-1, {label: 'unallocated'})
    const csv = ticketsToCsv([ticket(0)], leftover)
    const lines = csv.split('\r\n')
    expect(lines.at(-1)).toBe(
      `leftover,500,unallocated,yes,${toBech32Lnurl(leftover.noteUrl)}`
    )
  })

  it('omits the leftover row when there is none', () => {
    const csv = ticketsToCsv([ticket(0)], null)
    expect(csv.split('\r\n')).toHaveLength(2)
  })

  it('appends a fees row when a fee figure is known, converting msat to sat', () => {
    const csv = ticketsToCsv([ticket(0)], null, 274_000)
    expect(csv.split('\r\n').at(-1)).toBe('fees,274,,,')
  })

  it('omits the fees row when the figure is null or unset', () => {
    expect(ticketsToCsv([ticket(0)], null, null).split('\r\n')).toHaveLength(2)
    expect(ticketsToCsv([ticket(0)]).split('\r\n')).toHaveLength(2)
  })

  it('includes both leftover and fees rows together', () => {
    const leftover = ticket(-1, {label: 'unallocated'})
    const csv = ticketsToCsv([ticket(0)], leftover, 1000)
    const lines = csv.split('\r\n')
    expect(lines).toHaveLength(4)
    expect(lines[2]).toBe(
      `leftover,500,unallocated,yes,${toBech32Lnurl(leftover.noteUrl)}`
    )
    expect(lines[3]).toBe('fees,1,,,')
  })
})
