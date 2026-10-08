import { describe, it, expect } from '@jest/globals'

import {
  readProductUrl,
  readSellerOffer,
  readSellerOffers
} from '#/modules/kuantokusta/domain/seller-offer'

import { fakeOffer } from '../../../../support/fake-kk-server'

describe('readSellerOffer', () => {
  it('maps a real-shaped item', () => {
    expect(readSellerOffer(fakeOffer(1))).toEqual({
      ok: true,
      offer: {
        offerRef: 'p-9-30001',
        productExternalId: 3400001,
        productUrl: 'https://www.kuantokusta.pt/p/3400001/produto-de-teste-1',
        productName: 'Produto de teste 1 (KK)',
        name: 'Produto de teste 1',
        sku: '6800001',
        ean: '5600000000001',
        storeUrl: 'https://loja.example/produto/teste-1/',
        priceCents: 1034,
        stock: 13,
        isTopBox: false,
        updatedAt: new Date('2026-10-07T23:49:45.000Z')
      }
    })
  })

  it('converts the price to cents without drifting', () => {
    const cents = (price: number) => {
      const reading = readSellerOffer(fakeOffer(1, { price }))
      return reading.ok ? reading.offer.priceCents : reading.reason
    }

    expect(cents(0.3)).toBe(30)
    expect(cents(59.04)).toBe(5904)
    expect(cents(232.47)).toBe(23247)
    expect(cents(19)).toBe(1900)
    expect(cents(0)).toBe(0)
  })

  it('keeps text printable, so one odd character cannot fail a whole batch', () => {
    const reading = readSellerOffer(
      fakeOffer(1, {
        productName: '  Creme\u0000 hidratante\n50ml \ud83d ',
        productNameKK: 'Creme\thidratante',
        sku: '68\u000019730'
      })
    )

    expect(reading.ok && reading.offer).toMatchObject({
      name: 'Creme  hidratante 50ml',
      productName: 'Creme hidratante',
      sku: '68 19730'
    })
  })

  it('stores the store URL in its normalised form', () => {
    const url = (value: string) => {
      const reading = readSellerOffer(fakeOffer(1, { url: value }))
      return reading.ok ? reading.offer.storeUrl : reading.reason
    }

    expect(url('https://loja.example/produto/x/')).toBe(
      'https://loja.example/produto/x/'
    )
    expect(url('https://LOJA.example/produto/caf\u00e9\n')).toBe(
      'https://loja.example/produto/caf%C3%A9'
    )
    expect(url('https://loja.example\\produto\\x')).toBe(
      'https://loja.example/produto/x'
    )
    expect(url('https://user:pw@loja.example/x')).toBe('bad_store_url')
  })

  it('treats missing optional fields as absent, not as an error', () => {
    const reading = readSellerOffer(
      fakeOffer(1, { sku: null, ean: '  ', updatedAt: 'yesterday' })
    )

    expect(reading.ok && reading.offer).toMatchObject({
      sku: null,
      ean: null,
      updatedAt: null
    })
  })

  it('falls back to the other name when one is missing', () => {
    const onlyOwn = readSellerOffer(fakeOffer(1, { productNameKK: '' }))
    const onlyKk = readSellerOffer(fakeOffer(1, { productName: null }))

    expect(onlyOwn.ok && onlyOwn.offer.productName).toBe('Produto de teste 1')
    expect(onlyKk.ok && onlyKk.offer.name).toBe('Produto de teste 1 (KK)')
  })

  it('reads isTopBox strictly', () => {
    const top = (isTopBox: unknown) => {
      const reading = readSellerOffer(fakeOffer(1, { isTopBox }))
      return reading.ok && reading.offer.isTopBox
    }

    expect(top(true)).toBe(true)
    expect(top('true')).toBe(false)
    expect(top(1)).toBe(false)
  })

  it.each([
    ['not_an_object', null],
    ['not_an_object', 'offer'],
    ['not_an_object', []],
    ['missing_offer_ref', fakeOffer(1, { productId: null })],
    ['missing_offer_ref', fakeOffer(1, { productId: 30068 })],
    ['missing_offer_ref', fakeOffer(1, { productId: 'x'.repeat(65) })],
    ['bad_product_url', fakeOffer(1, { productUrl: undefined })],
    ['missing_name', fakeOffer(1, { productName: '', productNameKK: ' ' })],
    ['bad_store_url', fakeOffer(1, { url: null })],
    ['bad_store_url', fakeOffer(1, { url: 'javascript:alert(1)' })],
    ['bad_store_url', fakeOffer(1, { url: 'loja.example/produto' })],
    ['bad_price', fakeOffer(1, { price: '9.34' })],
    ['bad_price', fakeOffer(1, { price: -1 })],
    ['bad_price', fakeOffer(1, { price: Number.NaN })],
    ['bad_price', fakeOffer(1, { price: 1e9 })],
    ['bad_stock', fakeOffer(1, { stock: -1 })],
    ['bad_stock', fakeOffer(1, { stock: 1.5 })],
    ['bad_stock', fakeOffer(1, { stock: '13' })]
  ])('skips with %s', (reason, item) => {
    expect(readSellerOffer(item)).toEqual({ ok: false, reason })
  })
})

describe('readProductUrl', () => {
  it('accepts a plain KuantoKusta product page', () => {
    expect(
      readProductUrl('https://www.kuantokusta.pt/p/3456679/lutsine-eryplast')
    ).toEqual({
      url: 'https://www.kuantokusta.pt/p/3456679/lutsine-eryplast',
      externalId: 3456679
    })
  })

  // This URL is fetched later. Each of these would send that request
  // somewhere it must not go.
  it.each([
    'http://www.kuantokusta.pt/p/1/x',
    'https://kuantokusta.pt/p/1/x',
    'https://www.kuantokusta.pt.evil.example/p/1/x',
    'https://evil.example/p/1/x',
    'https://www.kuantokusta.pt@evil.example/p/1/x',
    'https://user:pass@www.kuantokusta.pt/p/1/x',
    'https://www.kuantokusta.pt:8443/p/1/x',
    'https://www.kuantokusta.pt/p/1/x?price=1',
    'https://www.kuantokusta.pt/p/1/x#frag',
    'https://www.kuantokusta.pt/search?q=x',
    'https://www.kuantokusta.pt/api/p/1/x',
    'https://www.kuantokusta.pt/p/1',
    'https://www.kuantokusta.pt/p/abc/x',
    'https://www.kuantokusta.pt/p/0/x',
    'https://www.kuantokusta.pt/p/1/x/y',
    'https://www.kuantokusta.pt/p/../api/x',
    // Text a URL parser forgives, and another parser may read differently.
    'https://www.kuantokusta.pt\\p\\1\\x@evil.example',
    'https://www.kuantokusta.pt/p/1/x@evil.example',
    'https://www.kuantokusta.pt/p/1/a\tb',
    'https://www.kuantokusta.pt/p/1/a\nb',
    'https://www.kuantokusta.pt/p/1/x\r\nHost: evil.example',
    'https://www.kuantokusta.pt/p/1/x%0d%0aHost:evil',
    ' https://www.kuantokusta.pt/p/1/x',
    'https://www.kuantokusta.pt/p/1/x ',
    'https:www.kuantokusta.pt/p/1/x',
    'https:////www.kuantokusta.pt/p/1/x',
    'https://WWW.KUANTOKUSTA.PT/p/1/x',
    'HTTPS://www.kuantokusta.pt/p/1/x',
    'https://www.kuantokusta.pt:443/p/1/x',
    'https://www.kuantokusta.pt./p/1/x',
    'https://www.kuantokusta.pt/p/2/../1/x',
    'https://\uff57\uff57\uff57.kuantokusta.pt/p/1/x',
    'https://www.kuantokusta.pt/p/1/caf\u00e9',
    'https://www.kuantokusta.pt/p/01/x',
    'https://www.kuantokusta.pt/p/1/x/',
    'https://169.254.169.254/p/1/x',
    'https://localhost/p/1/x',
    'file:///p/1/x',
    '//www.kuantokusta.pt/p/1/x',
    '',
    `https://www.kuantokusta.pt/p/1/${'x'.repeat(2000)}`
  ])('refuses %s', (url) => {
    expect(readProductUrl(url)).toBeNull()
  })

  it.each([null, undefined, 42, {}])('refuses the non-text value %j', (value) => {
    expect(readProductUrl(value)).toBeNull()
  })
})

describe('readSellerOffers', () => {
  it('keeps the usable items and counts the rest by reason', () => {
    const { offers, skipped } = readSellerOffers([
      fakeOffer(1),
      fakeOffer(2, { price: null }),
      fakeOffer(3),
      'garbage',
      fakeOffer(4, { price: -5 })
    ])

    expect(offers.map((offer) => offer.offerRef)).toEqual([
      'p-9-30001',
      'p-9-30003'
    ])
    expect(skipped).toEqual({ bad_price: 2, not_an_object: 1 })
  })

  it('keeps the first of two items with the same reference or product', () => {
    const { offers, skipped } = readSellerOffers([
      fakeOffer(1),
      fakeOffer(2, { productId: 'p-9-30001' }),
      fakeOffer(3, { productUrl: fakeOffer(1).productUrl }),
      fakeOffer(4)
    ])

    expect(offers.map((offer) => offer.sku)).toEqual(['6800001', '6800004'])
    expect(skipped).toEqual({ duplicate_in_response: 2 })
  })

  it('reports nothing skipped for a clean response', () => {
    expect(readSellerOffers([fakeOffer(1), fakeOffer(2)]).skipped).toEqual({})
    expect(readSellerOffers([])).toEqual({ offers: [], skipped: {} })
  })
})
