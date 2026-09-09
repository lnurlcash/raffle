import {describe, expect, it, vi} from 'vitest'
import {secp256k1} from '@noble/curves/secp256k1.js'
import {bytesToHex} from '@noble/hashes/utils.js'
import {hashK1, noteSignatureDigestForHash} from 'lnurlcash-kit'
import {checkTicketsLive, combineNotes} from './recovery'

const MINT_URL = 'https://mint.test/w'

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

// A mock mint that understands a merge request (repeated k1 params + a
// single h, no amount/h2 - see mergeNotesWithHash's wire format) alongside
// the same hash-only informational lookup combineNotes uses to learn the
// merged result's value afterward.
const createMergeMockMint = (
  privateKey: Uint8Array,
  mintPubkey: string,
  notesByK1: Record<string, number>
) => {
  const notes = new Map(
    Object.entries(notesByK1).map(([k1, amountMsat]) => [
      k1,
      {amountMsat, spent: false}
    ])
  )
  const committed = new Map<string, number>()

  const fetchMock = (async (input: string | URL) => {
    const url = new URL(input.toString())
    const params = url.searchParams
    const k1s = params.getAll('k1')
    const h = params.get('h')

    if (k1s.length === 0) {
      if (!h) return jsonResponse({status: 'ERROR', reason: 'missing k1'})
      for (const [noteK1, note] of notes) {
        if (!note.spent && hashK1(noteK1) === h) {
          return jsonResponse({
            tag: 'withdrawRequest',
            callback: MINT_URL,
            minWithdrawable: 0,
            maxWithdrawable: note.amountMsat,
            mintPubkey
          })
        }
      }
      const committedAmount = committed.get(h)
      if (committedAmount === undefined) {
        return jsonResponse({status: 'ERROR', reason: 'Unknown note.'})
      }
      return jsonResponse({
        tag: 'withdrawRequest',
        callback: MINT_URL,
        minWithdrawable: 0,
        maxWithdrawable: committedAmount,
        mintPubkey
      })
    }

    if (h) {
      // merge: every named k1 must be live and unspent
      let total = 0
      for (const k1 of k1s) {
        const note = notes.get(k1)
        if (!note || note.spent) {
          return jsonResponse({status: 'ERROR', reason: 'Unknown note.'})
        }
        total += note.amountMsat
      }
      for (const k1 of k1s) notes.get(k1)!.spent = true
      committed.set(h, total)
      return jsonResponse({status: 'OK', sig: sign(privateKey, h, total)})
    }

    return jsonResponse({status: 'ERROR', reason: 'unsupported request'})
  }) as unknown as typeof fetch

  return {fetchMock}
}

describe('combineNotes', () => {
  it('merges several notes into one whose value is their sum, and verifies it', async () => {
    const privateKey = secp256k1.utils.randomSecretKey()
    const mintPubkey = bytesToHex(secp256k1.getPublicKey(privateKey, true))
    const k1a = randomHex32()
    const k1b = randomHex32()
    const k1c = randomHex32()

    const mint = createMergeMockMint(privateKey, mintPubkey, {
      [k1a]: 10_000,
      [k1b]: 20_000,
      [k1c]: 5_000
    })
    vi.stubGlobal('fetch', mint.fetchMock)

    const result = await combineNotes(MINT_URL, [k1a, k1b, k1c])

    expect(result.amountMsat).toBe(35_000)
    expect(result.verified).toBe(true)
    expect(new URL(result.noteUrl).searchParams.get('amount')).toBe('35000')
  })

  it('refuses to merge a note that is already spent', async () => {
    const privateKey = secp256k1.utils.randomSecretKey()
    const mintPubkey = bytesToHex(secp256k1.getPublicKey(privateKey, true))
    const k1a = randomHex32()
    const spentK1 = randomHex32()

    const mint = createMergeMockMint(privateKey, mintPubkey, {[k1a]: 10_000})
    vi.stubGlobal('fetch', mint.fetchMock)

    await expect(combineNotes(MINT_URL, [k1a, spentK1])).rejects.toThrow()
  })
})

describe('checkTicketsLive', () => {
  it('classifies known tickets as live or spent by hash, without disclosing k1s for spent ones', async () => {
    const privateKey = secp256k1.utils.randomSecretKey()
    const mintPubkey = bytesToHex(secp256k1.getPublicKey(privateKey, true))
    const liveK1 = randomHex32()
    const goneK1 = randomHex32()

    const mint = createMergeMockMint(privateKey, mintPubkey, {
      [liveK1]: 21_000
    })
    vi.stubGlobal('fetch', mint.fetchMock)

    const results = await checkTicketsLive([
      {index: 0, noteUrl: `${MINT_URL}?k1=${liveK1}&amount=21000`},
      {index: 1, noteUrl: `${MINT_URL}?k1=${goneK1}&amount=5000`}
    ])

    const live = results.find(r => r.index === 0)!
    const gone = results.find(r => r.index === 1)!
    expect(live.live).toBe(true)
    expect(live.amountMsat).toBe(21_000)
    expect(live.k1).toBe(liveK1)
    expect(gone.live).toBe(false)
  })

  it('reports a ticket with no k1 in its noteUrl as not live, without a network call', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const results = await checkTicketsLive([
      {index: 0, noteUrl: 'not-a-valid-note-url'}
    ])

    expect(results).toEqual([{index: 0, k1: '', amountMsat: 0, live: false}])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
