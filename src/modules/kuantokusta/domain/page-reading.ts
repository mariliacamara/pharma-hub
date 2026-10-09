import { parseProductPage } from './page-offers'
import type { PageOffer } from './page-offers'

/**
 * What one attempt to read a product page produced. The values are the ones
 * the `kk_page_snapshots.outcome` column accepts.
 *
 *   ok             the page was read and its list of offers found
 *   not_found      the page no longer exists
 *   blocked        the site refused this client, or asked it to prove it is
 *                  a person
 *   no_offer_list  the page came, but the offers are not where they are
 *                  expected: the site changed
 *   http_error     any other answer
 *   network_error  no answer at all
 */
export type PageOutcome
  = | 'ok'
    | 'not_found'
    | 'blocked'
    | 'no_offer_list'
    | 'http_error'
    | 'network_error'

export interface PageReading {
  outcome: PageOutcome
  /** Null only when there was no answer. */
  httpStatus: number | null
  /** Present exactly when the outcome is `ok`. */
  offers: PageOffer[] | null
}

// Titles of the pages a bot protection service shows instead of the content.
const CHALLENGE_TITLE
  = /just a moment|attention required|access denied|access to this page has been denied|captcha|um momento/i
// Every part is bounded, so a page built to make this slow cannot.
const HEAD_LENGTH = 64 * 1024
const TITLE = /<title[^>]{0,200}>([^<]{0,300})<\/title>/i

/**
 * True for a page that is a challenge or a refusal rather than a product.
 * Such a page can come with status 200, so the status alone is not enough.
 */
export function looksLikeChallenge(html: string): boolean {
  // The title is at the top of a page. Looking only there keeps the cost
  // small whatever the page is made of.
  const title = TITLE.exec(html.slice(0, HEAD_LENGTH))?.[1] ?? ''
  return CHALLENGE_TITLE.test(title) || html.includes('px-captcha')
}

/**
 * Turns an HTTP answer into a reading.
 *
 * A block is told apart from every other failure on purpose: the collection
 * stops after a few blocks in a row, because insisting only makes things
 * worse for the address it runs from.
 */
export function readPageResponse(status: number, html: string): PageReading {
  const failed = (outcome: PageOutcome): PageReading => ({
    outcome,
    httpStatus: status,
    offers: null
  })

  if (status === 403 || status === 429) return failed('blocked')
  if (status === 404 || status === 410) return failed('not_found')
  if (status !== 200) {
    return failed(looksLikeChallenge(html) ? 'blocked' : 'http_error')
  }

  const parsed = parseProductPage(html)
  if (parsed.outcome === 'ok') {
    return { outcome: 'ok', httpStatus: status, offers: parsed.offers }
  }
  return failed(looksLikeChallenge(html) ? 'blocked' : 'no_offer_list')
}
