# LNURLcash Raffle

A print-a-raffle configurator for [LNURLcash](https://github.com/lnurl/luds/pull/301)
bearer notes. Paste in one bearer note, configure prize tiers, and the app
splits it into many smaller bearer notes - one per ticket - and generates a
print-ready PDF: a grid of ticket cards, each with a QR code and its note as
text, meant to be cut out and handed out (or rolled up, tombola-style).

## What it does

- **Prize tiers & presets** - build a tier table (N tickets worth X sat
  each) by hand, or start from a preset (single winner, classic raffle,
  prize pyramid, even split) and edit from there.
- **Ticket pricing** - set a price per ticket and see the revenue/payout/take
  (haircut) if every ticket sells, or work it backwards: enter a target
  margin and get the ticket price needed to hit it.
- **Preview PDF** - render the exact print layout with placeholder tickets
  before touching the real note, so the design can be checked risk-free.
- **Crash-safe splitting** - every step of turning the note into tickets is
  persisted before the app does anything else with the result, so a crash
  or refresh mid-run can't lose a minted secret. An interrupted run resumes
  where it left off.
- **CSV export** - a plain-text manifest of a finished run (ticket #,
  amount, label, note, signed) for the organizer's own records, separate
  from the PDF that gets handed out.

## This moves real money

Splitting a note is irreversible: it burns the note you provide and mints
new bearer notes at the mint. There is no backend here beyond the mint
itself - no accounts, no server-side storage. Whatever a ticket's QR code
encodes is spendable by whoever holds it, same as cash.

## Stack

TypeScript, [SolidJS](https://www.solidjs.com/), [Vite](https://vitejs.dev/),
[`lnurlcash-kit`](https://www.npmjs.com/package/lnurlcash-kit) for the
protocol, [`pdf-lib`](https://pdf-lib.js.org/) + [`qrcode`](https://www.npmjs.com/package/qrcode)
for the print sheet (QR codes are drawn as vector rectangles, not embedded
raster images, so they stay crisp at any print size).

## Running it

```bash
npm install
npm run dev      # local dev server
npm run build    # production build -> dist/
npm test         # vitest
npm run tsc      # typecheck
```

See `.github/workflows/` for CI and the GitHub Pages release flow.
