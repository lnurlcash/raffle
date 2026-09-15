import {beforeEach, describe, expect, it, vi} from 'vitest'
import {deriveNoteSecretKey, encodeCk1, signNoteOwnership} from '@lnurlcash/kit'
import {
  branchFor,
  cashRootFromPhrase,
  clearCashRoot,
  generateSeedPhrase,
  hasCashRoot,
  isValidSeedPhrase,
  loadCashRoot,
  nextCk1For,
  nextIndexFor,
  raiseIndexFor,
  saveCashRoot
} from './seed'

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

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage())
})

describe('generateSeedPhrase / isValidSeedPhrase', () => {
  it('generates a valid 12-word phrase', () => {
    const phrase = generateSeedPhrase()
    expect(phrase.trim().split(/\s+/)).toHaveLength(12)
    expect(isValidSeedPhrase(phrase)).toBe(true)
  })

  it('is case/whitespace-insensitive and rejects garbage', () => {
    const phrase = generateSeedPhrase()
    expect(isValidSeedPhrase(`  ${phrase.toUpperCase()}  `)).toBe(true)
    expect(isValidSeedPhrase('not a real seed phrase at all')).toBe(false)
    expect(isValidSeedPhrase('')).toBe(false)
  })
})

describe('cashRootFromPhrase', () => {
  it('is deterministic for the same phrase, different for different ones', () => {
    const phraseA = generateSeedPhrase()
    const phraseB = generateSeedPhrase()
    const rootA1 = cashRootFromPhrase(phraseA)
    const rootA2 = cashRootFromPhrase(phraseA)
    const rootB = cashRootFromPhrase(phraseB)
    expect(Buffer.from(rootA1)).toEqual(Buffer.from(rootA2))
    expect(Buffer.from(rootA1)).not.toEqual(Buffer.from(rootB))
  })
})

describe('cash root storage', () => {
  it('round-trips through save/load, and hasCashRoot reflects presence', () => {
    expect(hasCashRoot()).toBe(false)
    expect(loadCashRoot()).toBeNull()

    const root = cashRootFromPhrase(generateSeedPhrase())
    saveCashRoot(root)
    expect(hasCashRoot()).toBe(true)
    const loaded = loadCashRoot()
    expect(loaded).not.toBeNull()
    expect(Buffer.from(loaded!)).toEqual(Buffer.from(root))
  })

  it('treats a differently-tagged (or untagged) stored value as no seed active', () => {
    // guards against a root saved by a future/incompatible derivation
    // scheme being silently reinterpreted as this one's seed bytes - see
    // seed.ts's ROOT_SCHEME comment
    localStorage.setItem(
      'lnurlcash-lottery:cash-root',
      JSON.stringify({scheme: 'some-other-scheme', seedHex: '00'.repeat(64)})
    )
    expect(hasCashRoot()).toBe(true)
    expect(loadCashRoot()).toBeNull()
  })

  it('clearCashRoot removes the root and every per-host counter', () => {
    const root = cashRootFromPhrase(generateSeedPhrase())
    saveCashRoot(root)
    raiseIndexFor('mint.example', 5)
    clearCashRoot()
    expect(hasCashRoot()).toBe(false)
    expect(loadCashRoot()).toBeNull()
    expect(nextIndexFor('mint.example')).toBe(0)
  })
})

describe('per-host index counters', () => {
  it('defaults to 0 and only ever raises, never lowers', () => {
    expect(nextIndexFor('mint.example')).toBe(0)
    raiseIndexFor('mint.example', 5)
    expect(nextIndexFor('mint.example')).toBe(5)
    raiseIndexFor('mint.example', 2) // lower - must not move it back
    expect(nextIndexFor('mint.example')).toBe(5)
    raiseIndexFor('mint.example', 9)
    expect(nextIndexFor('mint.example')).toBe(9)
  })

  it('tracks separate hosts independently', () => {
    raiseIndexFor('a.example', 3)
    raiseIndexFor('b.example', 7)
    expect(nextIndexFor('a.example')).toBe(3)
    expect(nextIndexFor('b.example')).toBe(7)
  })
})

describe('nextCk1For', () => {
  it("matches the kit's own per-index derivation", () => {
    const root = cashRootFromPhrase(generateSeedPhrase())
    const host = 'mint.example'
    const branch = branchFor(root, host)
    const expectedAt = (index: number) =>
      encodeCk1(
        signNoteOwnership(
          deriveNoteSecretKey(branch.privateKey, branch.chainCode, index)
        )
      )
    expect(nextCk1For(root, host)).toBe(expectedAt(0))
    expect(nextCk1For(root, host)).toBe(expectedAt(1))
  })

  it('persists the counter on every draw, before the caller does anything else', () => {
    const root = cashRootFromPhrase(generateSeedPhrase())
    const host = 'mint.example'
    expect(nextIndexFor(host)).toBe(0)
    nextCk1For(root, host)
    expect(nextIndexFor(host)).toBe(1)
    nextCk1For(root, host)
    expect(nextIndexFor(host)).toBe(2)
  })

  it('never repeats an index across calls, and resumes from the persisted one after a simulated reload', () => {
    const root = cashRootFromPhrase(generateSeedPhrase())
    const host = 'mint.example'
    const a = nextCk1For(root, host)
    const b = nextCk1For(root, host)

    // nextCk1For reads nextIndexFor fresh every call rather than holding
    // its own counter, so there's nothing to reconstruct after a simulated
    // reload - the next call already continues from the persisted index
    const c = nextCk1For(root, host)
    expect(c).not.toBe(a)
    expect(c).not.toBe(b)
    expect(nextIndexFor(host)).toBe(3)
  })
})
