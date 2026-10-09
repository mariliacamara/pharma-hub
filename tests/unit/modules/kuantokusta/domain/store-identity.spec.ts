import { describe, it, expect } from '@jest/globals'

import type { PageOffer } from '#/modules/kuantokusta/domain/page-offers'
import {
  guessStoreIdentity,
  learnSellerId
} from '#/modules/kuantokusta/domain/store-identity'

const offer = (
  storeSlug: string,
  priceCents: number,
  sellerId: number | null = null
): PageOffer => ({
  storeName: storeSlug,
  storeSlug,
  sellerId,
  priceCents,
  shippingCents: null,
  isHighlighted: false,
  isMarketplace: false
})

/** `count` pages on which "zincomed" has the store's own price. */
const ownPages = (count: number, sellerId: number | null = 77) =>
  Array.from({ length: count }, (_, n) => ({
    apiPriceCents: 1000 + n,
    offers: [
      offer('zincomed', 1000 + n, sellerId),
      offer('farmacia-b', 900 + n, 5),
      offer('farmacia-c', 1100 + n, 6)
    ]
  }))

describe('guessStoreIdentity', () => {
  it('finds the store whose page price equals its own price on every page', () => {
    expect(guessStoreIdentity(ownPages(8))).toEqual({
      kind: 'found',
      storeSlug: 'zincomed',
      sellerId: 77,
      pages: 8,
      matches: 8
    })
  })

  it('tolerates pages where the store\'s price lags behind or it is absent', () => {
    const samples = [
      ...ownPages(7),
      // The page still shows an older price.
      { apiPriceCents: 500, offers: [offer('zincomed', 550, 77)] },
      // The store is not on this page at all.
      { apiPriceCents: 700, offers: [offer('farmacia-b', 650, 5)] },
      { apiPriceCents: 800, offers: [offer('farmacia-c', 850, 6)] }
    ]

    expect(guessStoreIdentity(samples)).toMatchObject({
      kind: 'found',
      storeSlug: 'zincomed',
      pages: 10,
      matches: 7
    })
  })

  it('does not decide on too few pages', () => {
    expect(guessStoreIdentity(ownPages(4))).toEqual({
      kind: 'unknown',
      reason: 'too_few_pages',
      pages: 4
    })
  })

  it('does not count pages without any offer', () => {
    const samples = [
      ...ownPages(4),
      { apiPriceCents: 1, offers: [] },
      { apiPriceCents: 2, offers: [] }
    ]

    expect(guessStoreIdentity(samples)).toEqual({
      kind: 'unknown',
      reason: 'too_few_pages',
      pages: 4
    })
  })

  it('does not decide when no store matches on most pages', () => {
    const samples = [
      ...ownPages(5),
      ...Array.from({ length: 5 }, (_, n) => ({
        apiPriceCents: 2000 + n,
        offers: [offer('farmacia-b', 1900 + n, 5)]
      }))
    ]

    expect(guessStoreIdentity(samples)).toEqual({
      kind: 'unknown',
      reason: 'no_clear_match',
      pages: 10
    })
  })

  it('does not decide when a second store matches almost as often', () => {
    // A competitor that copies the store's price on most pages.
    const samples = ownPages(10).map((sample, n) =>
      n < 6
        ? {
            ...sample,
            offers: [...sample.offers, offer('copia', sample.apiPriceCents, 9)]
          }
        : sample
    )

    expect(guessStoreIdentity(samples)).toEqual({
      kind: 'unknown',
      reason: 'no_clear_match',
      pages: 10
    })
  })

  it('counts a store once per page, and ignores an empty slug', () => {
    const samples = ownPages(6).map((sample) => ({
      ...sample,
      offers: [
        ...sample.offers,
        // The same store listed twice, and a nameless entry at that price.
        offer('zincomed', sample.apiPriceCents, 77),
        offer('', sample.apiPriceCents, 3)
      ]
    }))

    expect(guessStoreIdentity(samples)).toMatchObject({
      kind: 'found',
      storeSlug: 'zincomed',
      matches: 6
    })
  })

  it('compares slugs without regard to case', () => {
    const samples = ownPages(6).map((sample, n) => ({
      ...sample,
      offers: sample.offers.map((entry) =>
        entry.storeSlug === 'zincomed' && n % 2 === 0
          ? { ...entry, storeSlug: 'Zincomed' }
          : entry
      )
    }))

    expect(guessStoreIdentity(samples)).toMatchObject({
      kind: 'found',
      storeSlug: 'zincomed',
      matches: 6
    })
  })

  it('leaves the seller id unknown when the pages do not show one', () => {
    expect(guessStoreIdentity(ownPages(6, null))).toMatchObject({
      kind: 'found',
      sellerId: null
    })
  })

  it('takes the seller id most pages show', () => {
    const samples = ownPages(6).map((sample, n) => ({
      ...sample,
      offers: sample.offers.map((entry) =>
        entry.storeSlug === 'zincomed' && n === 0
          ? { ...entry, sellerId: 999 }
          : entry
      )
    }))

    expect(guessStoreIdentity(samples)).toMatchObject({ sellerId: 77 })
  })
})

describe('learnSellerId', () => {
  it('reads the seller id of the store known by its slug', () => {
    const pages = ownPages(3).map((sample) => sample.offers)

    expect(learnSellerId('ZINCOMED', pages)).toBe(77)
  })

  it('gives nothing when the pages disagree, or do not show one', () => {
    const disagreeing = [
      [offer('zincomed', 1, 77)],
      [offer('zincomed', 2, 78)]
    ]

    expect(learnSellerId('zincomed', disagreeing)).toBeNull()
    expect(learnSellerId('zincomed', [[offer('zincomed', 1)]])).toBeNull()
    expect(learnSellerId('zincomed', [[offer('farmacia-b', 1, 5)]])).toBeNull()
    expect(learnSellerId('zincomed', [])).toBeNull()
  })
})
