import { describe, it, expect } from '@jest/globals'

import {
  looksLikeChallenge,
  readPageResponse
} from '#/modules/kuantokusta/domain/page-reading'

import { CHALLENGE_HTML, productPageHtml } from '../../../../support/fake-kk-site'

const PAGE = productPageHtml([
  { storeName: 'Zincomed', storeSlug: 'zincomed', sellerId: 77, price: 9.34 }
])

describe('readPageResponse', () => {
  it('reads the offers of a product page', () => {
    expect(readPageResponse(200, PAGE)).toEqual({
      outcome: 'ok',
      httpStatus: 200,
      offers: [
        {
          storeName: 'Zincomed',
          storeSlug: 'zincomed',
          sellerId: 77,
          priceCents: 934,
          shippingCents: null,
          isHighlighted: false,
          isMarketplace: false
        }
      ]
    })
  })

  it('keeps a page without any offer as read, with an empty list', () => {
    expect(readPageResponse(200, productPageHtml([]))).toEqual({
      outcome: 'ok',
      httpStatus: 200,
      offers: []
    })
  })

  it.each([403, 429])('takes a %i as a refusal', (status) => {
    expect(readPageResponse(status, '')).toEqual({
      outcome: 'blocked',
      httpStatus: status,
      offers: null
    })
  })

  it.each([404, 410])('takes a %i as a page that is gone', (status) => {
    expect(readPageResponse(status, PAGE).outcome).toBe('not_found')
  })

  it.each([500, 502, 503, 301, 204])(
    'takes a %i as an error, not as a refusal',
    (status) => {
      expect(readPageResponse(status, '<html></html>')).toEqual({
        outcome: 'http_error',
        httpStatus: status,
        offers: null
      })
    }
  )

  it('takes a challenge page as a refusal whatever its status', () => {
    expect(readPageResponse(200, CHALLENGE_HTML).outcome).toBe('blocked')
    expect(readPageResponse(503, CHALLENGE_HTML).outcome).toBe('blocked')
  })

  it('reports a page whose offers are not where expected, never "no offers"', () => {
    expect(
      readPageResponse(200, '<html><head><title>Produto</title></head></html>')
    ).toEqual({ outcome: 'no_offer_list', httpStatus: 200, offers: null })
  })

  it('does not take a real product page for a challenge because of its text', () => {
    const page = PAGE.replace('<body>', '<body><p>captcha access denied</p>')

    expect(readPageResponse(200, page).outcome).toBe('ok')
  })
})

describe('looksLikeChallenge', () => {
  it.each([
    '<title>Just a moment...</title>',
    '<TITLE>Attention Required! | Cloudflare</TITLE>',
    '<title>Access Denied</title>',
    '<title>Access to this page has been denied</title>',
    '<title>Um momento…</title>',
    '<html><body><div id="px-captcha"></div></body></html>'
  ])('recognises %s', (html) => {
    expect(looksLikeChallenge(html)).toBe(true)
  })

  it.each(['', '<title>Ben-u-ron 500 mg | KuantoKusta</title>', 'plain text'])(
    'does not flag %j',
    (html) => {
      expect(looksLikeChallenge(html)).toBe(false)
    }
  )

  it.each([
    ['title tags that never close', '<title '.repeat(580_000)],
    ['titles that never end', '<title>'.repeat(580_000)]
  ])('stays fast on a 4 MB page made of %s', (_case, html) => {
    const started = performance.now()

    expect(looksLikeChallenge(html)).toBe(false)
    expect(readPageResponse(200, html).outcome).toBe('no_offer_list')
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})
