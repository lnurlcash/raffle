// A plain-text manifest of a finished run for the organizer's own records -
// separate from the PDF, which is what gets cut up and given away. Anyone
// holding this file holds every printed ticket's bearer secret, same as the
// PDF does: treat it with the same care.
import type {TicketRecord} from './storage'

const CSV_HEADER = ['ticket', 'sat', 'label', 'signed', 'note'] as const

// RFC 4180: quote a field only if it contains the delimiter, a quote, or a
// line break, doubling any embedded quotes
const escapeCsvField = (value: string): string =>
  /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value

const ticketRow = (t: TicketRecord, label: string): string[] => [
  label,
  String(Math.floor(t.amountMsat / 1000)),
  t.label,
  t.verified ? 'yes' : 'no',
  t.noteUrl
]

export const ticketsToCsv = (
  tickets: TicketRecord[],
  leftover?: TicketRecord | null
): string => {
  const rows: string[][] = [[...CSV_HEADER]]
  for (const t of [...tickets].sort((a, b) => a.index - b.index)) {
    rows.push(ticketRow(t, String(t.index + 1)))
  }
  if (leftover) rows.push(ticketRow(leftover, 'leftover'))
  return rows.map(row => row.map(escapeCsvField).join(',')).join('\r\n')
}
