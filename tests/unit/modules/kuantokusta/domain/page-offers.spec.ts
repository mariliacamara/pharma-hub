import { describe, it, expect } from '@jest/globals'
import { parseProductPage, type PageOffer } from '#/modules/kuantokusta/domain/page-offers'

/**
 * Builds a page with the structure observed on KuantoKusta on 2026-10-08. The offer
 * below copies the field names of a real entry; the values are illustrative.
 */
function pageWith(offers: unknown, wrap = true): string {
  const data = wrap ? { props: { pageProps: { basePage: { product: { offers } } } } } : offers
  return `<!DOCTYPE html><html><head><title>Product</title>
    <script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>
    </head><body><div id="__next"></div></body></html>`
}

const realShapedOffer = {
  isHighlighted: true,
  productId: 3524536,
  sellerId: 13192,
  badges: {},
  lastCheckedAt: '2026-10-08T00:27:42.000Z',
  logo: 'https://s1.kuantokusta.pt/img_upload/logins/13192_1.png',
  oldPrice: 67.29,
  paymentMethods: [],
  price: 52.99,
  productName: 'Omron Monitor De Presión Arterial',
  rating: { ratingCount: 0, reviewsCount: 0, url: null },
  shipping: { expectedDeliveryDate: null, minimumPrice: 1.99 },
  storeName: 'TechInn',
  storeSlug: 'techinn',
  id: null,
  filters: { isFastDelivery: false, isFreeShipping: false, isMarketplace: false },
  businessRules: { cpc: { isClickable: true, active: true }, mkt: { active: false } }
}

function offersOf(html: string): PageOffer[] {
  const result = parseProductPage(html)
  if (result.outcome !== 'ok') throw new Error(`expected offers, got ${result.outcome}`)
  return result.offers
}

describe('parseProductPage', () => {
  it('maps a real-shaped offer to the fixed set of fields', () => {
    expect(offersOf(pageWith([realShapedOffer]))).toEqual([
      {
        storeName: 'TechInn',
        storeSlug: 'techinn',
        sellerId: 13192,
        priceCents: 5299,
        shippingCents: 199,
        isHighlighted: true,
        isMarketplace: false
      }
    ])
  })

  it.each([
    [59.04, 5904],
    [0.29, 29],
    [1.005, 100],
    [19.99, 1999],
    [100, 10000]
  ])('converts the price %s to %s cents', (price, cents) => {
    expect(offersOf(pageWith([{ ...realShapedOffer, price }]))[0]?.priceCents).toBe(cents)
  })

  it('keeps an offer without shipping information, with null shipping', () => {
    const [offer] = offersOf(pageWith([{ ...realShapedOffer, shipping: { minimumPrice: null } }]))
    expect(offer?.shippingCents).toBeNull()
  })

  it('treats free shipping as zero, not as unknown', () => {
    const [offer] = offersOf(pageWith([{ ...realShapedOffer, shipping: { minimumPrice: 0 } }]))
    expect(offer?.shippingCents).toBe(0)
  })

  it.each([
    ['no price', { ...realShapedOffer, price: undefined }],
    ['a zero price', { ...realShapedOffer, price: 0 }],
    ['a negative price', { ...realShapedOffer, price: -5 }],
    ['a price sent as text', { ...realShapedOffer, price: '52.99' }],
    ['no store name or slug', { ...realShapedOffer, storeName: '', storeSlug: null }],
    ['a value that is not an object', 'TechInn 52.99'],
    ['null', null]
  ])('skips an entry with %s', (_label, entry) => {
    expect(offersOf(pageWith([entry, realShapedOffer]))).toHaveLength(1)
  })

  it('reads an empty list as "no store sells it", which is a valid page', () => {
    expect(parseProductPage(pageWith([]))).toEqual({ outcome: 'ok', offers: [] })
  })

  it.each([
    ['the script tag is missing', '<html><body>Just a moment...</body></html>'],
    ['the embedded document is not JSON', pageWith('x').replace('"x"', '{broken')],
    ['the offers path is missing', pageWith({ props: { pageProps: { basePage: {} } } }, false)],
    ['the offers are not a list', pageWith({ techinn: realShapedOffer })],
    ['the document is a list', pageWith([1, 2, 3], false)]
  ])('reports no_offer_list when %s', (_label, html) => {
    expect(parseProductPage(html)).toEqual({ outcome: 'no_offer_list' })
  })

  it('copies no markup or oversized text from the page', () => {
    const [offer] = offersOf(
      pageWith([{ ...realShapedOffer, storeName: `  ${'x'.repeat(5000)}  `, sellerId: '13192' }])
    )
    expect(offer?.storeName).toHaveLength(200)
    expect(offer?.sellerId).toBeNull()
  })

  it('finds the embedded data whatever comes before the id in the tag', () => {
    const data = JSON.stringify({
      props: { pageProps: { basePage: { product: { offers: [realShapedOffer] } } } }
    })

    for (const tag of [
      `<script id="__NEXT_DATA__" type="application/json">`,
      `<script type="application/json" id="__NEXT_DATA__">`,
      `<script type='application/json' id='__NEXT_DATA__' nonce="x">`
    ]) {
      expect(offersOf(`<html><body>${tag}${data}</script></body></html>`))
        .toHaveLength(1)
    }
  })

  it('does not take the id written in plain text for the data', () => {
    const html = '<p>the id="__NEXT_DATA__" block</p><b>{"props":{}}</b></script>'

    expect(parseProductPage(html)).toEqual({ outcome: 'no_offer_list' })
  })

  it.each([
    ['a price no store charges', { price: 1_000_000.01 }],
    ['a price built to overflow the arithmetic', { price: 1e300 }]
  ])('leaves out an offer with %s', (_case, change) => {
    const offers = offersOf(
      pageWith([realShapedOffer, { ...realShapedOffer, ...change, storeSlug: 'x' }])
    )

    expect(offers.map((offer) => offer.storeSlug)).toEqual(['techinn'])
  })

  it('reads a shipping cost no store charges as unknown', () => {
    const [offer] = offersOf(
      pageWith([{ ...realShapedOffer, shipping: { minimumPrice: 1e12 } }])
    )

    expect(offer.shippingCents).toBeNull()
  })

  it('does not accept a list far longer than any real page has', () => {
    const many = Array.from({ length: 1_001 }, () => realShapedOffer)

    expect(parseProductPage(pageWith(many))).toEqual({ outcome: 'no_offer_list' })
    expect(offersOf(pageWith(many.slice(0, 1_000)))).toHaveLength(1_000)
  })

  it.each([
    ['unclosed script tags', '<script '.repeat(500_000)],
    ['tags that open the data and never close', '<script id="__NEXT_DATA__" '.repeat(150_000)],
    ['the id repeated without a tag', 'id="__NEXT_DATA__"'.repeat(200_000)],
    ['data that never ends', `<script id="__NEXT_DATA__">${'{"a":'.repeat(700_000)}`]
  ])('stays fast on a 4 MB page made of %s', (_case, html) => {
    const started = performance.now()

    expect(parseProductPage(html.slice(0, 4 * 1024 * 1024)).outcome)
      .toBe('no_offer_list')
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})
