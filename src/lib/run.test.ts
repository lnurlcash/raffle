// Regression coverage for the bug fixed in run.ts: foldSplitOutputs used to
// call @lnurlcash/kit's settleNote on every split output, which silently
// rotates the note to obtain a signature - meaning every split was actually
// two mutations (split, then rotate) against the mint, not one. Real-world
// mints choked on that ("missing h" - see the commit this test landed in).
// The mock mint below models LUD-25's hash-commitment properly (a split's
// outputs are only known by h/h2 until something later reveals the raw k1,
// same as a real mint), and is strict: revealing a k1 that doesn't match a
// commitment, or spending twice, is refused rather than silently accepted -
// so an unexpected extra round trip fails the test instead of passing it.
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {secp256k1} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, utf8ToBytes} from '@noble/hashes/utils.js'
import {
  configureSecretProvider,
  decodeCp1,
  deriveNoteSecretKey,
  encodeCk1,
  hashK1,
  isCk1,
  isCp1,
  cp1FromCk1,
  signNoteOwnership,
  splitNote
} from '@lnurlcash/kit'
import {startRun, resumeRun, rotateTicketRecord} from './run'
import {defaultConfig, emptyTier} from './lottery'
import {
  branchFor,
  cashRootFromPhrase,
  generateSeedPhrase,
  nextCk1For,
  nextIndexFor
} from './seed'
import type {PersistedRun} from './storage'

const MINT_URL = 'https://mint.test/w'

class MemoryStorage {
  private store = new Map<string, string>()
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null
  }
  setItem(key: string, value: string) {
    this.store.set(key, value)
  }
  removeItem(key: string) {
    this.store.delete(key)
  }
}

const randomHex32 = (): string =>
  bytesToHex(crypto.getRandomValues(new Uint8Array(32)))

// @lnurlcash/kit computes this internally (signature.ts) but doesn't export
// it - the mock mint needs to reproduce it to hand back a signature the
// code under test will actually verify.
const LIGHTNING_SIGNED_MESSAGE_PREFIX = utf8ToBytes('Lightning Signed Message:')

const noteSignatureDigestForHash = (
  h: string,
  amountMsat: number
): Uint8Array => {
  const message = utf8ToBytes(
    `LNURLcash:${amountMsat}:${h.trim().toLowerCase()}`
  )
  return sha256(
    sha256(new Uint8Array([...LIGHTNING_SIGNED_MESSAGE_PREFIX, ...message]))
  )
}

const sign = (
  privateKey: Uint8Array,
  h: string,
  amountMsat: number
): string => {
  const digest = noteSignatureDigestForHash(h, amountMsat)
  const sig = secp256k1.sign(digest, privateKey, {
    prehash: false,
    format: 'recovered'
  })
  return bytesToHex(sig)
}

// The default random-hex secret provider @lnurlcash/kit itself falls back
// to when nothing is configured - restored before every test so a seed
// configured by one test (see the "derives ticket secrets" test below)
// never leaks into the next one. Production wiring (see
// lib/lnurlcashConfig.ts) is never imported by this file, so tests own this
// explicitly instead.
const defaultSecretProvider = () =>
  bytesToHex(crypto.getRandomValues(new Uint8Array(32)))

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {'content-type': 'application/json'}
  })

// A single-mint mock that models LUD-25's hash-commitment: a split commits
// its outputs by h/h2, and a later request naming their raw k1 is only
// honoured once it's checked against that commitment (activateByK1) - same
// as what happens when a chain of splits keeps spending the previous
// split's own change output, exactly what this app's run loop does. Also
// answers a hash-only informational lookup (fetchNoteInfoByHash - no k1 on
// the wire) against that same commitment, for a note never separately
// revealed - exactly what the final leftover is until run.ts's fee check.
const createMockMint = (
  privateKey: Uint8Array,
  mintPubkey: string,
  initialK1: string,
  initialAmountMsat: number,
  feePerSplitMsat = 0,
  refuseRotate = false
) => {
  const notes = new Map<string, {amountMsat: number; spent: boolean}>()
  // keyed by whatever a commitment names a not-yet-disclosed output by - a
  // raw hash for a legacy secret, a cp1 pubkey for a ck1 (Part 2) one
  const committed = new Map<string, number>()
  notes.set(initialK1, {amountMsat: initialAmountMsat, spent: false})
  const calls: string[] = []

  // the key a k1 is committed/looked up by - a hash for a legacy secret, or
  // the cp1 pubkey a ck1 secret's signature recovers to for a Part 2 one
  const commitmentKeyFor = (k1: string): string =>
    isCk1(k1) ? cp1FromCk1(k1)! : hashK1(k1)

  // the bytes an offline signature is actually computed over - a raw hash
  // for a legacy commitment field, or the raw (non-bech32m) pubkey bytes for
  // a p1/p2 one, see @lnurlcash/kit's verifyNoteSignature ck1 branch
  const signDigestKeyFor = (fieldValue: string): string =>
    isCp1(fieldValue) ? bytesToHex(decodeCp1(fieldValue)!) : fieldValue

  const activateByK1 = (k1: string) => {
    if (notes.has(k1)) return
    const key = commitmentKeyFor(k1)
    const amountMsat = committed.get(key)
    if (amountMsat === undefined) return
    committed.delete(key)
    notes.set(k1, {amountMsat, spent: false})
  }

  // names a callback unique to whatever it's keyed by (a hash for a by-hash
  // lookup, a raw k1 for a by-k1 one) rather than the fixed MINT_URL every
  // other response uses - a mint whose callback legitimately varies by
  // lookup kind, which is exactly what exposes a caller that carries one
  // note's (or one lookup kind's) callback forward for a different note.
  const callbackFor = (key: string) => `${MINT_URL}?note=${key}`

  const fetchMock = (async (input: string | URL) => {
    const url = new URL(input.toString())
    calls.push(url.toString())
    const params = url.searchParams
    const k1 = params.get('k1')
    // a commitment field is `h`/`h2` for a legacy secret's output, `p1`/`p2`
    // for a ck1 (Part 2) one - see @lnurlcash/kit's outputFieldName
    const lookupKey = params.get('h') ?? params.get('p')
    const key1 = params.get('h') ?? params.get('p1')
    const key2 = params.get('h2') ?? params.get('p2')

    if (!k1) {
      if (!lookupKey) {
        return jsonResponse({status: 'ERROR', reason: 'missing k1'})
      }
      // hash/pubkey-only lookup: check both a note already revealed by some
      // other request, and one only ever committed so far.
      for (const [noteK1, note] of notes) {
        if (!note.spent && commitmentKeyFor(noteK1) === lookupKey) {
          return jsonResponse({
            tag: 'withdrawRequest',
            callback: callbackFor(lookupKey),
            minWithdrawable: 0,
            maxWithdrawable: note.amountMsat,
            mintPubkey
          })
        }
      }
      const committedAmount = committed.get(lookupKey)
      if (committedAmount !== undefined) {
        return jsonResponse({
          tag: 'withdrawRequest',
          callback: callbackFor(lookupKey),
          minWithdrawable: 0,
          maxWithdrawable: committedAmount,
          mintPubkey
        })
      }
      return jsonResponse({status: 'ERROR', reason: 'Unknown note.'})
    }
    activateByK1(k1)
    const note = notes.get(k1)
    if (!note || note.spent) {
      return jsonResponse({status: 'ERROR', reason: 'Unknown note.'})
    }

    if (key1 && key2) {
      const amountMsat = Number(params.get('amount'))
      if (!Number.isFinite(amountMsat) || amountMsat > note.amountMsat) {
        return jsonResponse({status: 'ERROR', reason: 'invalid split request'})
      }
      note.spent = true
      const changeAmountMsat = note.amountMsat - amountMsat - feePerSplitMsat
      committed.set(key1, amountMsat)
      committed.set(key2, changeAmountMsat)
      return jsonResponse({
        status: 'OK',
        sig: sign(privateKey, signDigestKeyFor(key1), amountMsat),
        sig2: sign(privateKey, signDigestKeyFor(key2), changeAmountMsat)
      })
    }

    if (key1) {
      if (refuseRotate) {
        // an outright refusal: nothing committed, nothing burned - the
        // note this mock started with is still exactly as it was
        return jsonResponse({status: 'ERROR', reason: 'rotate not allowed'})
      }
      // rotate: burns k1, mints a fresh note of the same value under key1
      note.spent = true
      committed.set(key1, note.amountMsat)
      return jsonResponse({
        status: 'OK',
        sig: sign(privateKey, signDigestKeyFor(key1), note.amountMsat)
      })
    }

    // by-k1 informational lookup: also names a callback unique to this
    // note (`?note=<k1>`, distinct from the by-hash form's `?note=<hash>`
    // above) rather than the fixed MINT_URL - this mint hands back a
    // different callback depending on how a note was looked up, which is
    // exactly what exposed a ticket wrongly carrying the change output's
    // by-hash callback instead of confirming its own by k1.
    return jsonResponse({
      tag: 'withdrawRequest',
      callback: callbackFor(k1),
      k1,
      minWithdrawable: 0,
      maxWithdrawable: note.amountMsat,
      mintPubkey
    })
  }) as unknown as typeof fetch

  return {fetchMock, calls}
}

describe('startRun against a mock mint', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    // reset to the plain-random default before every test, so a seed
    // configured by one test (see "derives ticket secrets" below) never
    // leaks into the next one
    configureSecretProvider(defaultSecretProvider)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('splits every ticket in exactly one mint call each - no extra settle/rotate round trip', async () => {
    const privateKey = secp256k1.utils.randomSecretKey()
    const mintPubkey = bytesToHex(secp256k1.getPublicKey(privateKey, true))
    const initialK1 = randomHex32()
    const initialAmountMsat = 100_000 // 100 sat

    const mint = createMockMint(
      privateKey,
      mintPubkey,
      initialK1,
      initialAmountMsat
    )
    vi.stubGlobal('fetch', mint.fetchMock)

    const config = {
      ...defaultConfig(),
      tiers: [
        {...emptyTier(), count: 1, amountSat: 50, label: 'Grand prize'},
        {...emptyTier(), count: 1, amountSat: 30, label: ''}
      ]
    }

    const runs: PersistedRun[] = []
    await startRun(
      `${MINT_URL}?k1=${initialK1}&amount=${initialAmountMsat}`,
      config,
      run => runs.push(run)
    )

    const final = runs.at(-1)!
    expect(final.state).toBe('done')
    expect(final.tickets).toHaveLength(2)
    expect(final.tickets.every(t => t.verified)).toBe(true)
    expect(final.tickets.map(t => t.amountMsat).sort((a, b) => a - b)).toEqual([
      30_000, 50_000
    ])
    expect(final.leftover?.amountMsat).toBe(100_000 - 50_000 - 30_000)

    // the fixed bug's whole point: one informational GET to start, then per
    // ticket exactly one split call plus one hash-only confirmation lookup
    // for its change (never the settle-triggered rotate pair - an extra
    // mutation - that used to follow every split)
    expect(mint.calls).toHaveLength(5)
    expect(final.usesSeed).toBe(false)
    expect(final.feesMsat).toBe(0)

    // a Solid (or any Object.is-equality) signal setter must see a distinct
    // reference on every call to reliably re-render - run.ts mutates one
    // working object internally, so onUpdate must never be handed that same
    // reference twice, or a UI subscriber can miss updates (this is exactly
    // what caused a finished run to show stale progress with no buttons)
    const references = new Set(runs)
    expect(references.size).toBe(runs.length)
  })

  it("keeps every ticket, change and leftover on the note's own original callback, never a response-reported one", async () => {
    // regression: run.ts used to trust whatever `callback` field a mint's
    // response reported - whether from a by-hash lookup confirming a
    // change output's value, or a by-k1 lookup on a ticket itself - and
    // store that as a note's address. A callback in a response body is
    // that request's own target, not a durable note identity; this mint
    // hands back a distinct, marker-bearing callback for every such lookup
    // (see callbackFor) specifically so a caller that ever adopts one gets
    // caught here. Every output must carry the same bare callback the run
    // started with (see noteCallback/startRun) instead.
    const privateKey = secp256k1.utils.randomSecretKey()
    const mintPubkey = bytesToHex(secp256k1.getPublicKey(privateKey, true))
    const initialK1 = randomHex32()
    const initialAmountMsat = 100_000

    const mint = createMockMint(
      privateKey,
      mintPubkey,
      initialK1,
      initialAmountMsat
    )
    vi.stubGlobal('fetch', mint.fetchMock)

    const config = {
      ...defaultConfig(),
      tiers: [
        {...emptyTier(), count: 1, amountSat: 50, label: ''},
        {...emptyTier(), count: 1, amountSat: 30, label: ''}
      ]
    }

    const runs: PersistedRun[] = []
    await startRun(
      `${MINT_URL}?k1=${initialK1}&amount=${initialAmountMsat}`,
      config,
      run => runs.push(run)
    )

    const final = runs.at(-1)!
    const byIndex = [...final.tickets].sort((a, b) => a.index - b.index)
    const callbackOf = (noteUrl: string) => {
      const u = new URL(noteUrl)
      u.searchParams.delete('k1')
      u.searchParams.delete('amount')
      u.searchParams.delete('sig')
      return u.toString()
    }

    expect(callbackOf(byIndex[0]!.noteUrl)).toBe(MINT_URL)
    expect(callbackOf(byIndex[1]!.noteUrl)).toBe(MINT_URL)
    expect(callbackOf(final.leftover!.noteUrl)).toBe(MINT_URL)
  })

  it('calculates total mint fees as the gap between nominal and authoritative leftover value', async () => {
    const privateKey = secp256k1.utils.randomSecretKey()
    const mintPubkey = bytesToHex(secp256k1.getPublicKey(privateKey, true))
    const initialK1 = randomHex32()
    const initialAmountMsat = 100_000
    const feePerSplitMsat = 137

    const mint = createMockMint(
      privateKey,
      mintPubkey,
      initialK1,
      initialAmountMsat,
      feePerSplitMsat
    )
    vi.stubGlobal('fetch', mint.fetchMock)

    const config = {
      ...defaultConfig(),
      tiers: [
        {...emptyTier(), count: 1, amountSat: 50, label: 'Grand prize'},
        {...emptyTier(), count: 1, amountSat: 30, label: ''}
      ]
    }

    const runs: PersistedRun[] = []
    await startRun(
      `${MINT_URL}?k1=${initialK1}&amount=${initialAmountMsat}`,
      config,
      run => runs.push(run)
    )

    const final = runs.at(-1)!
    expect(final.state).toBe('done')
    // ticket amounts are exact regardless of fees - only the leftover
    // (fed by two fee-shaved change outputs in a row) absorbs them
    expect(final.tickets.map(t => t.amountMsat).sort((a, b) => a - b)).toEqual([
      30_000, 50_000
    ])
    const expectedLeftover = 100_000 - 50_000 - 30_000 - 2 * feePerSplitMsat
    expect(final.leftover?.amountMsat).toBe(expectedLeftover)
    expect(final.leftover?.verified).toBe(true)
    expect(final.feesMsat).toBe(2 * feePerSplitMsat)
  })

  it('derives ticket secrets from an active seed, in index order, and advances the persisted counter', async () => {
    const privateKey = secp256k1.utils.randomSecretKey()
    const mintPubkey = bytesToHex(secp256k1.getPublicKey(privateKey, true))
    const initialK1 = randomHex32()
    const initialAmountMsat = 100_000

    const mint = createMockMint(
      privateKey,
      mintPubkey,
      initialK1,
      initialAmountMsat
    )
    vi.stubGlobal('fetch', mint.fetchMock)

    const cashRoot = cashRootFromPhrase(generateSeedPhrase())
    const host = 'mint.test' // serverOf(MINT_URL)
    const branch = branchFor(cashRoot, host)
    // production wiring (lib/lnurlcashConfig.ts) is never imported by
    // tests - this reproduces just enough of it for the duration of this
    // test, reset by the top-level beforeEach afterward
    configureSecretProvider(domain => nextCk1For(cashRoot, domain))

    const config = {
      ...defaultConfig(),
      tiers: [
        {...emptyTier(), count: 1, amountSat: 50, label: 'Grand prize'},
        {...emptyTier(), count: 1, amountSat: 30, label: ''}
      ]
    }

    const runs: PersistedRun[] = []
    await startRun(
      `${MINT_URL}?k1=${initialK1}&amount=${initialAmountMsat}`,
      config,
      run => runs.push(run),
      cashRoot
    )

    const final = runs.at(-1)!
    expect(final.state).toBe('done')
    expect(final.usesSeed).toBe(true)

    const byIndex = [...final.tickets].sort((a, b) => a.index - b.index)
    const k1Of = (noteUrl: string) => new URL(noteUrl).searchParams.get('k1')
    const ck1At = (index: number) =>
      encodeCk1(
        signNoteOwnership(
          deriveNoteSecretKey(branch.privateKey, branch.chainCode, index)
        )
      )

    // splitNote draws newK1 then changeK1 per call: ticket 1's secret is
    // index 0, its change (input to the next split) is index 1, ticket 2's
    // secret is index 2, and the final leftover is index 3
    expect(k1Of(byIndex[0]!.noteUrl)).toBe(ck1At(0))
    expect(k1Of(byIndex[1]!.noteUrl)).toBe(ck1At(2))
    expect(k1Of(final.leftover!.noteUrl)).toBe(ck1At(3))

    // two splits * two draws each - persisted durably, not just in memory
    expect(nextIndexFor(host)).toBe(4)
  })

  it('finishes the last ticket with whatever is actually left when fees eat the margin', async () => {
    // mirrors a real report: 3 tickets configured at 30 sat each against a
    // 90 sat note (zero margin), a mint that takes 1 sat per split - by the
    // third ticket there's only 28 sat left, exactly the "amount must be
    // between 0 and 28000 msat" shape that used to strand the run
    const privateKey = secp256k1.utils.randomSecretKey()
    const mintPubkey = bytesToHex(secp256k1.getPublicKey(privateKey, true))
    const initialK1 = randomHex32()
    const initialAmountMsat = 90_000
    const feePerSplitMsat = 1_000

    const mint = createMockMint(
      privateKey,
      mintPubkey,
      initialK1,
      initialAmountMsat,
      feePerSplitMsat
    )
    vi.stubGlobal('fetch', mint.fetchMock)

    const config = {
      ...defaultConfig(),
      tiers: [{...emptyTier(), count: 3, amountSat: 30, label: ''}]
    }

    const runs: PersistedRun[] = []
    await startRun(
      `${MINT_URL}?k1=${initialK1}&amount=${initialAmountMsat}`,
      config,
      run => runs.push(run)
    )

    const final = runs.at(-1)!
    expect(final.state).toBe('done')
    expect(final.tickets).toHaveLength(3)
    expect(final.leftover).toBeNull()
    const amounts = final.tickets
      .sort((a, b) => a.index - b.index)
      .map(t => t.amountMsat)
    expect(amounts[0]).toBe(30_000)
    expect(amounts[1]).toBe(30_000)
    expect(amounts[2]).toBe(90_000 - 30_000 - 1_000 - 30_000 - 1_000) // 28_000
    expect(final.tickets.every(t => t.verified)).toBe(true)
    expect(final.message).toMatch(/reduced/i)
  })

  it('recovers a stuck run whose stale balance only fails once the mint actually rejects it', async () => {
    // simulates resuming a run persisted before this app tracked fees
    // accurately after every split: `current.amountMsat` still claims more
    // than is really there, so the proactive check waves it through and
    // only the mint's own refusal (the reactive path in handleMutationError)
    // catches the shortfall - same real-world report, one split further in
    const privateKey = secp256k1.utils.randomSecretKey()
    const mintPubkey = bytesToHex(secp256k1.getPublicKey(privateKey, true))
    const initialK1 = randomHex32()
    const initialAmountMsat = 90_000
    const feePerSplitMsat = 1_000

    const mint = createMockMint(
      privateKey,
      mintPubkey,
      initialK1,
      initialAmountMsat,
      feePerSplitMsat
    )
    vi.stubGlobal('fetch', mint.fetchMock)

    // perform the first two splits directly against the mock (bypassing
    // run.ts) to reach the exact same mint-side state a real prior session
    // would have left behind, with two genuine tickets already minted
    const split1 = await splitNote(MINT_URL, [initialK1], 30_000)
    const split2 = await splitNote(MINT_URL, [split1.change], 30_000)
    // real balance on split2.change is 90_000 - 30_000 - 1_000 - 30_000 -
    // 1_000 = 28_000, but this run's persisted bookkeeping (from before fee
    // tracking) still claims the full nominal 30_000 was left

    const config = {
      ...defaultConfig(),
      tiers: [{...emptyTier(), count: 3, amountSat: 30, label: ''}]
    }
    const staleRun: PersistedRun = {
      id: 'stale',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      config,
      mintPubkey,
      noteCallback: MINT_URL,
      plan: [
        {index: 0, amountMsat: 30_000, label: ''},
        {index: 1, amountMsat: 30_000, label: ''},
        {index: 2, amountMsat: 30_000, label: ''}
      ],
      tickets: [
        {
          index: 0,
          amountMsat: 30_000,
          label: '',
          noteUrl: `${MINT_URL}?k1=${split1.k1}&amount=30000`,
          verified: true
        },
        {
          index: 1,
          amountMsat: 30_000,
          label: '',
          noteUrl: `${MINT_URL}?k1=${split2.k1}&amount=30000`,
          verified: true
        }
      ],
      current: {
        k1: split2.change,
        amountMsat: 30_000, // stale - really 28_000
        signature: split2.changeSignature,
        callback: MINT_URL
      },
      pending: null,
      pendingKind: null,
      state: 'error',
      message: 'amount must be between 0 and 28000 msat.',
      leftover: null,
      feesMsat: null,
      usesSeed: false
    }

    const runs: PersistedRun[] = []
    await resumeRun(staleRun, run => runs.push(run))

    const final = runs.at(-1)!
    expect(final.state).toBe('done')
    expect(final.tickets).toHaveLength(3)
    expect(final.tickets.find(t => t.index === 2)?.amountMsat).toBe(28_000)
    expect(final.message).toMatch(/reduced/i)
  })

  it('rotateTicketRecord refreshes a ticket to a new k1/signature at the same value', async () => {
    const privateKey = secp256k1.utils.randomSecretKey()
    const mintPubkey = bytesToHex(secp256k1.getPublicKey(privateKey, true))
    const initialK1 = randomHex32()
    const initialAmountMsat = 100_000

    const mint = createMockMint(
      privateKey,
      mintPubkey,
      initialK1,
      initialAmountMsat
    )
    vi.stubGlobal('fetch', mint.fetchMock)

    const config = {
      ...defaultConfig(),
      tiers: [{...emptyTier(), count: 1, amountSat: 100, label: ''}]
    }
    const runs: PersistedRun[] = []
    await startRun(
      `${MINT_URL}?k1=${initialK1}&amount=${initialAmountMsat}`,
      config,
      run => runs.push(run)
    )
    const original = runs.at(-1)!.tickets[0]!
    expect(original.verified).toBe(true)

    const originalK1 = new URL(original.noteUrl).searchParams.get('k1')
    const rotated = await rotateTicketRecord(original, mintPubkey)

    expect(rotated.amountMsat).toBe(original.amountMsat)
    expect(rotated.verified).toBe(true)
    expect(rotated.index).toBe(original.index)
    const rotatedK1 = new URL(rotated.noteUrl).searchParams.get('k1')
    expect(rotatedK1).not.toBe(originalK1)

    // the old secret is burned - a lookup on it now fails
    await expect(
      mint
        .fetchMock(`${MINT_URL}?h=${hashK1(originalK1!)}`)
        .then(r => r.json())
        .then(b => {
          if (b.status === 'ERROR') throw new Error(b.reason)
        })
    ).rejects.toThrow()
  })

  it("rotateTicketRecord keeps the ticket's own callback, never settleNote's reported one", async () => {
    // regression: rotateTicketRecord used to store settled.callback (the
    // response's own field, sourced from whichever kind of lookup settleNote
    // happened to make) as the rotated note's address. A rotate only ever
    // changes k1/signature/value - the note's own callback (see
    // noteCallback) must survive untouched, even though this mock's
    // by-k1 response reports a different, marker-bearing callback.
    const privateKey = secp256k1.utils.randomSecretKey()
    const mintPubkey = bytesToHex(secp256k1.getPublicKey(privateKey, true))
    const initialK1 = randomHex32()
    const initialAmountMsat = 100_000

    const mint = createMockMint(
      privateKey,
      mintPubkey,
      initialK1,
      initialAmountMsat
    )
    vi.stubGlobal('fetch', mint.fetchMock)

    const config = {
      ...defaultConfig(),
      tiers: [{...emptyTier(), count: 1, amountSat: 100, label: ''}]
    }
    const runs: PersistedRun[] = []
    await startRun(
      `${MINT_URL}?k1=${initialK1}&amount=${initialAmountMsat}`,
      config,
      run => runs.push(run)
    )
    const original = runs.at(-1)!.tickets[0]!

    const rotated = await rotateTicketRecord(original, mintPubkey)

    const callbackOf = (noteUrl: string) => {
      const u = new URL(noteUrl)
      u.searchParams.delete('k1')
      u.searchParams.delete('amount')
      u.searchParams.delete('sig')
      return u.toString()
    }
    expect(callbackOf(rotated.noteUrl)).toBe(MINT_URL)
  })

  it('rotateTicketRecord throws instead of accepting a refused rotate as if it succeeded', async () => {
    // regression: settleNote falls back to returning the note exactly as
    // it was - same k1, same signature - when the mint refuses a rotate
    // outright (nothing burned, nothing landed). Treating that as a
    // successful rotation silently produced a "rotated" ticket identical
    // to the one before it - this should surface as a clear error instead.
    const privateKey = secp256k1.utils.randomSecretKey()
    const mintPubkey = bytesToHex(secp256k1.getPublicKey(privateKey, true))
    const initialK1 = randomHex32()
    const initialAmountMsat = 100_000

    const mint = createMockMint(
      privateKey,
      mintPubkey,
      initialK1,
      initialAmountMsat,
      0,
      true // refuseRotate
    )
    vi.stubGlobal('fetch', mint.fetchMock)

    const config = {
      ...defaultConfig(),
      tiers: [{...emptyTier(), count: 1, amountSat: 100, label: ''}]
    }
    const runs: PersistedRun[] = []
    await startRun(
      `${MINT_URL}?k1=${initialK1}&amount=${initialAmountMsat}`,
      config,
      run => runs.push(run)
    )
    const original = runs.at(-1)!.tickets[0]!

    await expect(rotateTicketRecord(original, mintPubkey)).rejects.toThrow(
      /refused/i
    )
  })
})
