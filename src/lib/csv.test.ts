import {describe, expect, it} from 'vitest'
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
    expect(row1).toBe('1,21000,,yes,https://mint.example/w?k1=0')
    expect(row2).toBe('2,500,,no,https://mint.example/w?k1=1')
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
    const csv = ticketsToCsv([ticket(0)], ticket(-1, {label: 'unallocated'}))
    const lines = csv.split('\r\n')
    expect(lines.at(-1)).toBe(
      'leftover,500,unallocated,yes,https://mint.example/w?k1=-1'
    )
  })

  it('omits the leftover row when there is none', () => {
    const csv = ticketsToCsv([ticket(0)], null)
    expect(csv.split('\r\n')).toHaveLength(2)
  })
})
