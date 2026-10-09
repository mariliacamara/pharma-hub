import { eurosToCents } from './money'

/**
 * Reads the list of store offers out of a KuantoKusta product page.
 *
 * The page embeds a JSON document in <script id="__NEXT_DATA__">, with the offers at
 * props.pageProps.basePage.product.offers (see docs/kuantokusta.md).
 *
 * The page belongs to a third party and is untrusted input: every field is checked and
 * copied into a fixed shape, and nothing from it is executed or used to build a URL.
 */

/** Bump when the extraction changes, so stored snapshots record which parser read them. */
export const PARSER_VERSION = 1

export interface PageOffer {
  storeName: string
  storeSlug: string
  sellerId: number | null
  priceCents: number
  /** Cheapest shipping the store advertises on the page; null when not shown. */
  shippingCents: number | null
  isHighlighted: boolean
  isMarketplace: boolean
}

export type PageParseResult
  = | { outcome: 'ok', offers: PageOffer[] }
  /**
   * The page was served but the offer list is not where it is expected. This means the
   * site changed its structure. It must be reported as such, never stored as "no offers".
   */
    | { outcome: 'no_offer_list' }

const MAX_TEXT_LENGTH = 200
// No store sells one item for this much. A larger number is a mistake or an
// attempt to break the arithmetic further on, and the offer is left out.
const MAX_PRICE_EUROS = 1_000_000
// A real page lists a few dozen stores. A list far beyond that is not a
// product page as the hub knows it.
const MAX_OFFERS = 1_000

/**
 * The text inside <script id="__NEXT_DATA__">, found by plain searching.
 *
 * Not a regular expression on purpose: on a page built for it, one would
 * take minutes, and the whole service shares one thread.
 */
function embeddedJson(html: string): string | undefined {
  for (const marker of ['id="__NEXT_DATA__"', 'id=\'__NEXT_DATA__\'']) {
    const at = html.indexOf(marker)
    if (at === -1) continue
    const tagStart = html.lastIndexOf('<', at)
    if (!/^<script\s/i.test(html.slice(tagStart, tagStart + 8))) continue
    const tagEnd = html.indexOf('>', at)
    if (tagEnd === -1) continue
    const close = html.indexOf('</script>', tagEnd)
    const closeUpper = close === -1 ? html.indexOf('</SCRIPT>', tagEnd) : close
    if (closeUpper === -1) continue
    return html.slice(tagEnd + 1, closeUpper)
  }
  return undefined
}

export function parseProductPage(html: string): PageParseResult {
  const embedded = embeddedJson(html)
  if (embedded === undefined) return { outcome: 'no_offer_list' }

  let document: unknown
  try {
    document = JSON.parse(embedded)
  } catch {
    return { outcome: 'no_offer_list' }
  }

  const list = dig(document, ['props', 'pageProps', 'basePage', 'product', 'offers'])
  if (!Array.isArray(list) || list.length > MAX_OFFERS) {
    return { outcome: 'no_offer_list' }
  }

  const offers: PageOffer[] = []
  for (const raw of list) {
    const offer = toPageOffer(raw)
    if (offer) offers.push(offer)
  }
  return { outcome: 'ok', offers }
}

/** Maps one raw entry to a PageOffer, or null when it lacks a usable price or store. */
function toPageOffer(raw: unknown): PageOffer | null {
  if (!isRecord(raw)) return null

  const price = raw.price
  if (
    typeof price !== 'number'
    || !Number.isFinite(price)
    || price <= 0
    || price > MAX_PRICE_EUROS
  ) {
    return null
  }

  const storeName = text(raw.storeName)
  const storeSlug = text(raw.storeSlug)
  if (!storeName && !storeSlug) return null

  const shipping = isRecord(raw.shipping) ? raw.shipping.minimumPrice : undefined
  const filters = isRecord(raw.filters) ? raw.filters : {}

  return {
    storeName: storeName || storeSlug,
    storeSlug,
    sellerId: Number.isSafeInteger(raw.sellerId) ? (raw.sellerId as number) : null,
    priceCents: eurosToCents(price),
    shippingCents:
      typeof shipping === 'number'
      && Number.isFinite(shipping)
      && shipping >= 0
      && shipping <= MAX_PRICE_EUROS
        ? eurosToCents(shipping)
        : null,
    isHighlighted: raw.isHighlighted === true,
    isMarketplace: filters.isMarketplace === true
  }
}

function dig(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const key of path) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return current
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TEXT_LENGTH) : ''
}
