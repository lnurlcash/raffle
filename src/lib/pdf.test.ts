import {describe, expect, it} from 'vitest'
import {PDFDocument} from 'pdf-lib'
import {generateLotteryPdf, previewTickets} from './pdf'
import {defaultConfig, emptyTier} from './lottery'
import type {TicketRecord} from './storage'

const ticket = (index: number, amountMsat: number): TicketRecord => ({
  index,
  amountMsat,
  label: '',
  noteUrl: `https://mint.example/w?k1=${index.toString(16).padStart(64, '0')}&amount=${amountMsat}`,
  verified: true
})

describe('generateLotteryPdf', () => {
  it('produces a well-formed, reloadable PDF', async () => {
    const tickets = Array.from({length: 5}, (_, i) => ticket(i, 500000))
    const bytes = await generateLotteryPdf(defaultConfig(), tickets)
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-')
    const reloaded = await PDFDocument.load(bytes)
    expect(reloaded.getPageCount()).toBeGreaterThanOrEqual(1)
  })

  it('fits more tickets across more pages, never fewer strips than tickets allow', async () => {
    const few = Array.from({length: 3}, (_, i) => ticket(i, 500000))
    const many = Array.from({length: 60}, (_, i) => ticket(i, 500000))
    const fewBytes = await generateLotteryPdf(defaultConfig(), few)
    const manyBytes = await generateLotteryPdf(defaultConfig(), many)
    const fewDoc = await PDFDocument.load(fewBytes)
    const manyDoc = await PDFDocument.load(manyBytes)
    expect(manyDoc.getPageCount()).toBeGreaterThan(fewDoc.getPageCount())
  })

  it('marks an unsigned ticket without throwing', async () => {
    const unsigned: TicketRecord = {...ticket(0, 21000), verified: false}
    const bytes = await generateLotteryPdf(defaultConfig(), [unsigned])
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-')
  })
})

describe('previewTickets / preview mode', () => {
  it('builds one placeholder ticket per planned ticket, with no real note', () => {
    const config = {
      ...defaultConfig(),
      tiers: [{...emptyTier(), count: 5, amountSat: 500}]
    }
    const tickets = previewTickets(config)
    expect(tickets).toHaveLength(5)
    for (const t of tickets) {
      expect(t.noteUrl).toBe('')
      expect(t.amountMsat).toBe(500000)
    }
  })

  it('renders a valid PDF for a preview run without touching toBech32Lnurl on an empty note', async () => {
    const config = {
      ...defaultConfig(),
      tiers: [{...emptyTier(), count: 3, amountSat: 1000}]
    }
    const bytes = await generateLotteryPdf(config, previewTickets(config), {
      preview: true
    })
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-')
    const reloaded = await PDFDocument.load(bytes)
    expect(reloaded.getPageCount()).toBeGreaterThanOrEqual(1)
  })
})
