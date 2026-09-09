import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {loadRun, saveRun, type PersistedRun} from './storage'
import {defaultConfig} from './lottery'

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

const baseRun = (): PersistedRun => ({
  id: 'test',
  createdAt: 0,
  updatedAt: 0,
  config: defaultConfig(),
  mintPubkey: '02'.padEnd(66, '0'),
  noteCallback: 'https://mint.test/w',
  plan: [],
  tickets: [],
  current: null,
  pending: null,
  pendingKind: null,
  state: 'done',
  message: null,
  leftover: null,
  feesMsat: 0,
  usesSeed: false
})

describe('loadRun migration', () => {
  let storage: MemoryStorage
  beforeEach(() => {
    storage = new MemoryStorage()
    vi.stubGlobal('localStorage', storage)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('strips a trailing /cb from a ticket and leftover noteUrl, but never from current.callback', () => {
    const run: PersistedRun = {
      ...baseRun(),
      tickets: [
        {
          index: 0,
          amountMsat: 30_000,
          label: '',
          noteUrl: 'https://mint.test/w/cb?k1=aaa&amount=30000',
          verified: true
        }
      ],
      leftover: {
        index: -1,
        amountMsat: 10_000,
        label: 'Leftover (not printed)',
        noteUrl: 'https://mint.test/w/cb?k1=bbb&amount=10000',
        verified: true
      },
      current: {
        k1: 'ccc',
        amountMsat: 5_000,
        callback: 'https://mint.test/w/cb'
      }
    }
    saveRun(run)

    const loaded = loadRun()!
    expect(loaded.tickets[0]!.noteUrl).toBe(
      'https://mint.test/w?k1=aaa&amount=30000'
    )
    expect(loaded.leftover!.noteUrl).toBe(
      'https://mint.test/w?k1=bbb&amount=10000'
    )
    // current.callback is the live mutation target for the next split or
    // rotate - it's supposed to point at /cb, so migration must leave it
    expect(loaded.current!.callback).toBe('https://mint.test/w/cb')
  })

  it('persists the migrated URLs back to storage, not just in the returned value', () => {
    const run: PersistedRun = {
      ...baseRun(),
      tickets: [
        {
          index: 0,
          amountMsat: 30_000,
          label: '',
          noteUrl: 'https://mint.test/w/cb?k1=aaa&amount=30000',
          verified: true
        }
      ]
    }
    saveRun(run)

    loadRun()
    const reloaded = loadRun()!
    expect(reloaded.tickets[0]!.noteUrl).toBe(
      'https://mint.test/w?k1=aaa&amount=30000'
    )
  })

  it('leaves an already-clean run untouched', () => {
    const run: PersistedRun = {
      ...baseRun(),
      tickets: [
        {
          index: 0,
          amountMsat: 30_000,
          label: '',
          noteUrl: 'https://mint.test/w?k1=aaa&amount=30000',
          verified: true
        }
      ]
    }
    saveRun(run)

    const loaded = loadRun()!
    expect(loaded.tickets[0]!.noteUrl).toBe(
      'https://mint.test/w?k1=aaa&amount=30000'
    )
  })
})
