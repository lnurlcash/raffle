// Renders the finished ticket plan to a print-ready PDF: a grid of cards,
// four side by side across the page, each with its QR code on top and the
// rest of the ticket's text below - narrow enough to cut out and roll up.
// The QR is drawn as filled rectangles from the QR matrix directly (see
// drawQr) rather than embedded as a raster image, so it stays crisp at any
// print size/DPI.
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage
} from 'pdf-lib'
import QRCode from 'qrcode'
import {toBech32Lnurl} from 'lnurlcash-kit'
import {
  planTickets,
  ticketCount,
  totalAmountSat,
  grossRevenueSat,
  haircutSat,
  haircutPercent,
  type LotteryConfig,
  type PaperSize
} from './lottery'
import type {TicketRecord} from './storage'

// A no-mint-contacted stand-in for what a real run would produce, so the
// print layout can be checked before the note behind it is ever split. The
// QR/note text is a plain marker string, never a real (or even
// real-looking) bearer note - see generateLotteryPdf's `preview` option.
export const previewTickets = (config: LotteryConfig): TicketRecord[] =>
  planTickets(config).map(t => ({
    index: t.index,
    amountMsat: t.amountMsat,
    label: t.label,
    noteUrl: '',
    verified: true
  }))

const MM = 2.8346456693 // points per mm, pdf-lib works in points

const PAGE_SIZE_MM: Record<PaperSize, [number, number]> = {
  a4: [210, 297],
  letter: [215.9, 279.4]
}

const MARGIN_MM = 10
const COLUMNS = 4
const ROWS = 4
const GAP_MM = 4
const CARD_PADDING_MM = 2.5

const drawQr = (
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  size: number
): void => {
  const qr = QRCode.create(text, {errorCorrectionLevel: 'M'})
  const n = qr.modules.size
  const cell = size / n
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (!qr.modules.get(row, col)) continue
      page.drawRectangle({
        x: x + col * cell,
        // PDF y grows upward; row 0 of the matrix is the top of the code
        y: y + size - (row + 1) * cell,
        width: cell,
        height: cell,
        color: rgb(0, 0, 0)
      })
    }
  }
}

// greedily wraps a string into lines no wider than maxWidth at this font/size
const wrapMonospace = (
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number
): string[] => {
  const lines: string[] = []
  let line = ''
  for (const ch of text) {
    const candidate = line + ch
    if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(line)
      line = ch
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line)
  return lines
}

// same idea as wrapMonospace, but breaks at word boundaries - for prose,
// where a mid-word break would be unreadable
const wrapWords = (
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number
): string[] => {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word
    if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line)
  return lines
}

// A summary page ahead of the ticket grid: what this raffle is, its prize
// tiers, and - if a ticket price was set - the same revenue/payout/haircut
// breakdown the configurator shows, so the printed packet is self-contained
// and doesn't depend on whoever printed it also keeping the app state.
const drawCoverPage = (
  doc: PDFDocument,
  config: LotteryConfig,
  fonts: {font: PDFFont; boldFont: PDFFont},
  pageWidth: number,
  pageHeight: number,
  preview: boolean
): void => {
  const {font, boldFont} = fonts
  const margin = MARGIN_MM * MM
  const contentWidth = pageWidth - 2 * margin
  const page = doc.addPage([pageWidth, pageHeight])
  let cursorY = pageHeight - margin

  if (preview) {
    page.drawText('PREVIEW - NOT A REAL RAFFLE YET', {
      x: margin,
      y: cursorY,
      size: 10,
      font: boldFont,
      color: rgb(0.75, 0.15, 0.15)
    })
    cursorY -= 7 * MM
  }

  page.drawText(config.title, {
    x: margin,
    y: cursorY,
    size: 22,
    font: boldFont,
    maxWidth: contentWidth
  })
  cursorY -= 10 * MM

  page.drawText('LNURLcash Raffle', {
    x: margin,
    y: cursorY,
    size: 11,
    font,
    color: rgb(0.45, 0.45, 0.45)
  })
  cursorY -= 9 * MM

  const explanation =
    'Each ticket on the following pages is a self-contained LNURLcash ' +
    'bearer note: whoever holds it holds the prize. Scan its QR code with ' +
    'any LNURL-compatible Lightning wallet to check its value and claim ' +
    'it - no registration or verification with the organizer is needed.'
  for (const line of wrapWords(explanation, font, 9.5, contentWidth)) {
    page.drawText(line, {x: margin, y: cursorY, size: 9.5, font})
    cursorY -= 4.8 * MM
  }
  cursorY -= 5 * MM

  page.drawText('Prize tiers', {
    x: margin,
    y: cursorY,
    size: 13,
    font: boldFont
  })
  cursorY -= 8 * MM

  const colTickets = margin
  const colPrize = margin + 28 * MM
  const colLabel = margin + 62 * MM

  page.drawText('Tickets', {x: colTickets, y: cursorY, size: 9, font: boldFont})
  page.drawText('Sat each', {x: colPrize, y: cursorY, size: 9, font: boldFont})
  page.drawText('Label', {x: colLabel, y: cursorY, size: 9, font: boldFont})
  cursorY -= 3 * MM
  page.drawLine({
    start: {x: margin, y: cursorY},
    end: {x: pageWidth - margin, y: cursorY},
    thickness: 0.5,
    color: rgb(0.75, 0.75, 0.75)
  })
  cursorY -= 5 * MM

  const sortedTiers = [...config.tiers].sort(
    (a, b) => b.amountSat - a.amountSat
  )
  for (const tier of sortedTiers) {
    page.drawText(String(Math.max(0, Math.floor(tier.count))), {
      x: colTickets,
      y: cursorY,
      size: 9.5,
      font
    })
    page.drawText(Math.max(0, Math.floor(tier.amountSat)).toLocaleString(), {
      x: colPrize,
      y: cursorY,
      size: 9.5,
      font
    })
    if (tier.label) {
      page.drawText(tier.label, {
        x: colLabel,
        y: cursorY,
        size: 9.5,
        font,
        maxWidth: pageWidth - margin - colLabel
      })
    }
    cursorY -= 5.5 * MM
  }
  cursorY -= 2 * MM

  page.drawText(
    `${ticketCount(config)} tickets total, ${totalAmountSat(config).toLocaleString()} sat prize pool`,
    {x: margin, y: cursorY, size: 10, font: boldFont}
  )
  cursorY -= 11 * MM

  page.drawText('Pricing', {x: margin, y: cursorY, size: 13, font: boldFont})
  cursorY -= 8 * MM

  const pricingLines =
    config.ticketPriceSat > 0
      ? (() => {
          const revenue = grossRevenueSat(config)
          const payout = totalAmountSat(config)
          const cut = haircutSat(config)
          const percent = haircutPercent(config)!
          return [
            `Ticket price: ${config.ticketPriceSat.toLocaleString()} sat`,
            `If all ${ticketCount(config)} tickets sell: ${revenue.toLocaleString()} sat collected, ${payout.toLocaleString()} sat paid out.`,
            cut >= 0
              ? `Organizer take (haircut): ${cut.toLocaleString()} sat (${percent.toFixed(1)}%).`
              : `Organizer subsidy: ${Math.abs(cut).toLocaleString()} sat (${percent.toFixed(1)}%) paid out more than collected.`
          ]
        })()
      : ['This is a free raffle - no ticket price was set.']

  for (const line of pricingLines) {
    for (const wrapped of wrapWords(line, font, 9.5, contentWidth)) {
      page.drawText(wrapped, {x: margin, y: cursorY, size: 9.5, font})
      cursorY -= 5 * MM
    }
  }
}

export const generateLotteryPdf = async (
  config: LotteryConfig,
  tickets: TicketRecord[],
  options: {preview?: boolean} = {}
): Promise<Uint8Array> => {
  const preview = options.preview ?? false
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold)
  const monoFont = await doc.embedFont(StandardFonts.Courier)

  const [pageWidthMm, pageHeightMm] = PAGE_SIZE_MM[config.paper]
  const pageWidth = pageWidthMm * MM
  const pageHeight = pageHeightMm * MM
  const margin = MARGIN_MM * MM
  const gap = GAP_MM * MM
  // both dimensions fill the page exactly - a fixed 4x4 grid per page,
  // rather than a fixed card size with leftover space at the bottom
  const cardWidth = (pageWidth - 2 * margin - (COLUMNS - 1) * gap) / COLUMNS
  const cardHeight = (pageHeight - 2 * margin - (ROWS - 1) * gap) / ROWS
  const padding = CARD_PADDING_MM * MM
  const cardsPerPage = ROWS * COLUMNS

  drawCoverPage(doc, config, {font, boldFont}, pageWidth, pageHeight, preview)

  const ordered = [...tickets].sort((a, b) => a.index - b.index)

  let page: PDFPage | null = null
  let cardOnPage = 0

  const addPage = () => {
    page = doc.addPage([pageWidth, pageHeight])
    cardOnPage = 0
  }

  for (const ticket of ordered) {
    if (!page || cardOnPage >= cardsPerPage) addPage()
    const p = page!

    const col = cardOnPage % COLUMNS
    const row = Math.floor(cardOnPage / COLUMNS)
    const left = margin + col * (cardWidth + gap)
    const top = pageHeight - margin - row * (cardHeight + gap)
    const bottom = top - cardHeight

    // a vertical cut line left of every card but the first in its row
    if (col > 0) {
      const cutX = left - gap / 2
      p.drawLine({
        start: {x: cutX, y: top},
        end: {x: cutX, y: bottom},
        thickness: 0.5,
        color: rgb(0.6, 0.6, 0.6),
        dashArray: [3, 3]
      })
    }
    // one horizontal cut line per row boundary, spanning the full row -
    // drawn once (from the row's first card) rather than once per card
    if (row > 0 && col === 0) {
      const cutY = top + gap / 2
      p.drawLine({
        start: {x: margin, y: cutY},
        end: {x: pageWidth - margin, y: cutY},
        thickness: 0.5,
        color: rgb(0.6, 0.6, 0.6),
        dashArray: [3, 3]
      })
    }

    const qrSize = cardWidth - 2 * padding
    const qrX = left + padding
    const qrY = top - padding - qrSize
    // a preview never encodes a real (or even real-shaped) bearer note - a
    // plain marker string, so nothing printed here could be mistaken for a
    // spendable QR even if it escaped this sheet
    const qrContent = preview
      ? `PREVIEW ${String(ticket.index + 1).padStart(3, '0')}`
      : toBech32Lnurl(ticket.noteUrl)
    drawQr(p, qrContent, qrX, qrY, qrSize)

    const textX = left + padding
    const textWidth = cardWidth - 2 * padding
    let cursorY = qrY - 3 * MM

    if (preview) {
      p.drawText('PREVIEW - NOT A REAL TICKET', {
        x: textX,
        y: cursorY,
        size: 5.5,
        font: boldFont,
        color: rgb(0.75, 0.15, 0.15)
      })
      cursorY -= 3 * MM
    }

    p.drawText(config.title, {
      x: textX,
      y: cursorY,
      size: 7.5,
      font: boldFont,
      maxWidth: textWidth
    })
    cursorY -= 3.3 * MM
    p.drawText(`Ticket #${String(ticket.index + 1).padStart(3, '0')}`, {
      x: textX,
      y: cursorY,
      size: 6.5,
      font
    })

    if (config.showAmount) {
      cursorY -= 3 * MM
      p.drawText(
        `${Math.floor(ticket.amountMsat / 1000).toLocaleString()} sat`,
        {x: textX, y: cursorY, size: 6.5, font}
      )
    }
    if (ticket.label) {
      cursorY -= 3 * MM
      p.drawText(ticket.label, {
        x: textX,
        y: cursorY,
        size: 6.5,
        font,
        maxWidth: textWidth
      })
    }
    if (!preview && !ticket.verified) {
      cursorY -= 3 * MM
      p.drawText('(unsigned by mint)', {
        x: textX,
        y: cursorY,
        size: 5.5,
        font,
        color: rgb(0.6, 0.3, 0)
      })
    }

    cursorY -= 3.3 * MM
    const noteLines = wrapMonospace(
      preview
        ? '(no note yet - appears after splitting)'
        : toBech32Lnurl(ticket.noteUrl),
      monoFont,
      4.2,
      textWidth
    )
    for (const line of noteLines) {
      if (cursorY < bottom + padding) break
      p.drawText(line, {x: textX, y: cursorY, size: 4.2, font: monoFont})
      cursorY -= 2.1 * MM
    }

    cardOnPage++
  }

  return doc.save()
}
