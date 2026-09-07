// Regression coverage for the bug fixed in run.ts: foldSplitOutputs used to
// call lnurlcash-kit's settleNote on every split output, which silently
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
import {bytesToHex} from '@noble/hashes/utils.js'
import {hashK1, noteSignatureDigestForHash} from 'lnurlcash-kit'
import {startRun} from './run'
import {defaultConfig, emptyTier} from './lottery'
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

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {'content-type': 'application/json'}
  })

// A single-mint mock that models LUD-25's hash-commitment: a split commits
// its outputs by h/h2, and a later request naming their raw k1 is only
// honoured once it's checked against that commitment (activateByK1) - same
// as what happens when a chain of splits keeps spending the previous
// split's own change output, exactly what this app's run loop does.
const createMockMint = (
  privateKey: Uint8Array,
  mintPubkey: string,
  initialK1: string,
  initialAmountMsat: number
) => {
  const notes = new Map<string, {amountMsat: number; spent: boolean}>()
  const committed = new Map<string, number>() // hash -> amountMsat
  notes.set(initialK1, {amountMsat: initialAmountMsat, spent: false})
  const calls: string[] = []

  const activateByK1 = (k1: string) => {
    if (notes.has(k1)) return
    const hash = hashK1(k1)
    const amountMsat = committed.get(hash)
    if (amountMsat === undefined) return
    committed.delete(hash)
    notes.set(k1, {amountMsat, spent: false})
  }

  const fetchMock = (async (input: string | URL) => {
    const url = new URL(input.toString())
    calls.push(url.toString())
    const params = url.searchParams
    const k1 = params.get('k1')
    const h = params.get('h')
    const h2 = params.get('h2')

    if (!k1) return jsonResponse({status: 'ERROR', reason: 'missing k1'})
    activateByK1(k1)
    const note = notes.get(k1)
    if (!note || note.spent) {
      return jsonResponse({status: 'ERROR', reason: 'Unknown note.'})
    }

    if (h) {
      const amountMsat = Number(params.get('amount'))
      if (!h2 || !Number.isFinite(amountMsat) || amountMsat > note.amountMsat) {
        return jsonResponse({status: 'ERROR', reason: 'invalid split request'})
      }
      note.spent = true
      const changeAmountMsat = note.amountMsat - amountMsat
      committed.set(h, amountMsat)
      committed.set(h2, changeAmountMsat)
      return jsonResponse({
        status: 'OK',
        sig: sign(privateKey, h, amountMsat),
        sig2: sign(privateKey, h2, changeAmountMsat)
      })
    }

    return jsonResponse({
      tag: 'withdrawRequest',
      callback: MINT_URL,
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

    // the fixed bug's whole point: one informational GET to start, then
    // exactly one mint call per ticket - never the settle-triggered rotate
    // pair (an extra GET + rotate) that used to follow every split
    expect(mint.calls).toHaveLength(3)
  })
})
