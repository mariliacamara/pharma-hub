import { describe, it, expect } from '@jest/globals'
import {
  comparePrices,
  differencePercent,
  isEasyAdjust,
  type StoreIdentity
} from '#/kuantokusta/domain/comparison'
import type { PageOffer } from '#/kuantokusta/domain/page-offers'

const zincomed: StoreIdentity = { storeSlug: 'zincomed', sellerId: null }

function offer(
  storeName: string,
  priceCents: number,
  shippingCents: number | null = null
): PageOffer {
  return {
    storeName,
    storeSlug: storeName.toLowerCase().replace(/\W+/g, '-'),
    sellerId: null,
    priceCents,
    shippingCents,
    isHighlighted: false,
    isMarketplace: false
  }
}

describe('comparePrices', () => {
  it('reports the store as more expensive, with the cheapest competitor', () => {
    // The case seen on 2026-10-08: the store at 59.04 EUR, another store at 52.99 EUR.
    const result = comparePrices({
      apiPriceCents: 5904,
      store: zincomed,
      offers: [offer('TechInn', 5299, 199), offer('Zincomed', 5904, 499), offer('Loja C', 6100, 0)]
    })

    expect(result).toEqual({
      outcome: 'more_expensive',
      storePriceCents: 5904,
      storeIsListed: true,
      lowestPriceCents: 5299,
      lowestStoreName: 'TechInn',
      lowestStoreSlug: 'techinn',
      differenceCents: 605,
      storePosition: 2,
      storeCount: 3,
      storeTotalCents: 6403,
      lowestTotalCents: 5498,
      lowestTotalStoreName: 'TechInn'
    })
    expect(differencePercent(result)).toBeCloseTo(10.25, 2)
  })

  it('reports the store as the cheapest, with a negative difference', () => {
    const result = comparePrices({
      apiPriceCents: 570,
      store: zincomed,
      offers: [offer('Zincomed', 570), offer('Farmácia A', 610), offer('Farmácia B', 700)]
    })
    expect(result.outcome).toBe('cheapest')
    expect(result.differenceCents).toBe(-40)
    expect(result.storePosition).toBe(1)
    expect(result.lowestStoreName).toBe('Farmácia A')
  })

  it('reports a tie, at position 1', () => {
    const result = comparePrices({
      apiPriceCents: 1000,
      store: zincomed,
      offers: [offer('Farmácia A', 1000), offer('Zincomed', 1000)]
    })
    expect(result.outcome).toBe('tied')
    expect(result.differenceCents).toBe(0)
    expect(result.storePosition).toBe(1)
  })

  it('reports only_store when nobody else sells the product', () => {
    const result = comparePrices({
      apiPriceCents: 800,
      store: zincomed,
      offers: [offer('Zincomed', 800, 499)]
    })
    expect(result).toMatchObject({
      outcome: 'only_store',
      lowestPriceCents: null,
      lowestStoreName: null,
      differenceCents: null,
      storePosition: 1,
      storeCount: 1,
      storeTotalCents: 1299,
      lowestTotalCents: null
    })
    expect(differencePercent(result)).toBeNull()
  })

  it('falls back to the Seller API price when the store is not on the page', () => {
    const result = comparePrices({
      apiPriceCents: 2000,
      store: zincomed,
      offers: [offer('Farmácia A', 1950), offer('Farmácia B', 2200)]
    })
    expect(result).toMatchObject({
      outcome: 'more_expensive',
      storePriceCents: 2000,
      storeIsListed: false,
      storePosition: null,
      storeTotalCents: null,
      differenceCents: 50
    })
  })

  it('trusts the price on the page over the Seller API price', () => {
    const result = comparePrices({
      apiPriceCents: 1500,
      store: zincomed,
      offers: [offer('Zincomed', 1550), offer('Farmácia A', 1400)]
    })
    expect(result.storePriceCents).toBe(1550)
    expect(result.differenceCents).toBe(150)
  })

  it('finds the lowest total separately from the lowest price', () => {
    const result = comparePrices({
      apiPriceCents: 1000,
      store: zincomed,
      offers: [
        offer('Zincomed', 1000, 499),
        offer('Cheap but far', 900, 990),
        offer('Free delivery', 950, 0),
        offer('Unknown shipping', 800, null)
      ]
    })
    expect(result.lowestStoreName).toBe('Unknown shipping')
    expect(result.lowestTotalStoreName).toBe('Free delivery')
    expect(result.lowestTotalCents).toBe(950)
  })

  it('recognises the store by its exact slug, not by a name that contains it', () => {
    const result = comparePrices({
      apiPriceCents: 1000,
      store: zincomed,
      offers: [
        offer('Zincomed', 1000),
        { ...offer('Zincomed Outlet', 500), storeSlug: 'zincomed-outlet' }
      ]
    })
    expect(result.lowestStoreName).toBe('Zincomed Outlet')
    expect(result.outcome).toBe('more_expensive')
  })

  it('prefers the seller id over the slug once it is known', () => {
    const renamed = { ...offer('Zinco Farma', 1000), storeSlug: 'zinco-farma', sellerId: 4242 }
    const result = comparePrices({
      apiPriceCents: 1000,
      store: { storeSlug: 'zincomed', sellerId: 4242 },
      offers: [renamed, { ...offer('Farmácia A', 900), sellerId: 7 }]
    })
    expect(result.storeIsListed).toBe(true)
    expect(result.differenceCents).toBe(100)
  })

  it('counts the position by price, whatever the order on the page', () => {
    const result = comparePrices({
      apiPriceCents: 1200,
      store: zincomed,
      offers: [
        offer('D', 1300),
        offer('Zincomed', 1200),
        offer('A', 1000),
        offer('B', 1100),
        offer('C', 1200)
      ]
    })
    expect(result.storePosition).toBe(3)
    expect(result.storeCount).toBe(5)
  })
})

describe('differencePercent', () => {
  it('is relative to the higher price, so it never passes 100%', () => {
    // 0.65 against 1.69: relative to the store price this would read -160%.
    const percent = differencePercent({
      storePriceCents: 65,
      lowestPriceCents: 169,
      differenceCents: -104
    })
    expect(percent).toBeCloseTo(-61.54, 2)
  })

  it('is zero on a tie', () => {
    expect(
      differencePercent({ storePriceCents: 1000, lowestPriceCents: 1000, differenceCents: 0 })
    ).toBe(0)
  })
})

describe('isEasyAdjust', () => {
  it.each([
    [1, true],
    [10, true],
    [11, false],
    [0, false],
    [-5, false],
    [null, false]
  ])('with a 10-cent threshold, a difference of %s cents is %s', (difference, expected) => {
    expect(isEasyAdjust(difference, 10)).toBe(expected)
  })

  it('holds exactly at the threshold for prices that are not exact in floating point', () => {
    // 0.30 - 0.20 is 0.09999999999999998 in floating point; in cents it is exactly 10.
    const result = comparePrices({
      apiPriceCents: 30,
      store: zincomed,
      offers: [offer('Zincomed', 30), offer('Farmácia A', 20)]
    })
    expect(result.differenceCents).toBe(10)
    expect(isEasyAdjust(result.differenceCents, 10)).toBe(true)
  })
})
