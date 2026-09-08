import {beforeEach, describe, expect, it, vi} from 'vitest'
import {cashSecretAt, deriveCashDomainNode} from 'lnurlcash-kit'
import {
  cashRootFromPhrase,
  clearCashRoot,
  createPersistentRandomSecret,
  generateSeedPhrase,
  hasCashRoot,
  isValidSeedPhrase,
  loadCashRoot,
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
    expect(Buffer.from(rootA1.privateKey)).toEqual(
      Buffer.from(rootA2.privateKey)
    )
    expect(Buffer.from(rootA1.privateKey)).not.toEqual(
      Buffer.from(rootB.privateKey)
    )
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
    expect(Buffer.from(loaded!.privateKey)).toEqual(
      Buffer.from(root.privateKey)
    )
    expect(Buffer.from(loaded!.chainCode)).toEqual(Buffer.from(root.chainCode))
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

describe('createPersistentRandomSecret', () => {
  it("matches the kit's own per-index derivation", () => {
    const root = cashRootFromPhrase(generateSeedPhrase())
    const host = 'mint.example'
    const domainNode = deriveCashDomainNode(root, host)
    const draw = createPersistentRandomSecret(root, host)
    expect(draw()).toBe(cashSecretAt(domainNode, 0))
    expect(draw()).toBe(cashSecretAt(domainNode, 1))
  })

  it('persists the counter on every draw, before the caller does anything else', () => {
    const root = cashRootFromPhrase(generateSeedPhrase())
    const host = 'mint.example'
    const draw = createPersistentRandomSecret(root, host)
    expect(nextIndexFor(host)).toBe(0)
    draw()
    expect(nextIndexFor(host)).toBe(1)
    draw()
    expect(nextIndexFor(host)).toBe(2)
  })

  it('resumes from the persisted index on a fresh call, never replaying one', () => {
    const root = cashRootFromPhrase(generateSeedPhrase())
    const host = 'mint.example'
    const first = createPersistentRandomSecret(root, host)
    const a = first()
    const b = first()

    // simulate a page reload: a brand new source built from the same
    // (persisted) starting point must continue, not restart at 0
    const resumed = createPersistentRandomSecret(root, host)
    const c = resumed()
    expect(c).not.toBe(a)
    expect(c).not.toBe(b)
    expect(nextIndexFor(host)).toBe(3)
  })
})
