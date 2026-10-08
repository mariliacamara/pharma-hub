import { lisbonWallTimeToInstant } from './lisbon-time'
import { eurosToCents } from './money'

/**
 * One of the store's own offers, as the hub keeps it.
 *
 * Built from an item of `GET /v2/kms/offers`. That response is third-party
 * data and differs from its own specification (docs/kuantokusta.md), so each
 * item is checked field by field and an item that cannot be used is skipped
 * with a reason instead of stopping the whole sync.
 */
export interface SellerOffer {
  /** "productId" in the API, e.g. "p-9-30068". Identifies the offer. */
  offerRef: string
  /** The id in the page URL, /p/<id>/<slug>. Identifies the product. */
  productExternalId: number
  /** The KuantoKusta product page, exactly as the API returned it. */
  productUrl: string
  /** The product's name on KuantoKusta. */
  productName: string
  /** The offer's name as the store registered it. */
  name: string
  sku: string | null
  ean: string | null
  /** The product page on the store's own site. */
  storeUrl: string
  priceCents: number
  stock: number
  isTopBox: boolean
  updatedAt: Date | null
}

export type SkipReason
  = | 'not_an_object'
    | 'missing_offer_ref'
    | 'bad_product_url'
    | 'missing_name'
    | 'bad_store_url'
    | 'bad_price'
    | 'bad_stock'
    | 'duplicate_in_response'

export type OfferReading
  = | { ok: true, offer: SellerOffer }
    | { ok: false, reason: SkipReason }

const PRODUCT_URL = /^https:\/\/www\.kuantokusta\.pt\/p\/([1-9]\d{0,14})\/[A-Za-z0-9._~-]+$/
const MAX_URL_LENGTH = 2000
const MAX_NAME_LENGTH = 500
const MAX_CODE_LENGTH = 64
const MAX_PRICE_EUROS = 1_000_000
const MAX_STOCK = 1_000_000_000

/**
 * The product page URL is fetched later by the price collection, so it is
 * the one field that could turn a bad API response into a request to an
 * arbitrary address. Only a plain product page on KuantoKusta's own site is
 * accepted: https, the exact host, `/p/<id>/<slug>`, nothing else.
 *
 * The text itself must already be that URL, character for character. A URL
 * parser forgives a great deal (backslashes for slashes, tabs and line
 * breaks inside, missing slashes, a host in other alphabets), and another
 * parser, in another language, may read the same forgiving text as a
 * different host. So nothing forgiving is stored: what is kept is exactly
 * what every parser agrees on.
 */
export function readProductUrl(
  value: unknown
): { url: string, externalId: number } | null {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return null

  const match = PRODUCT_URL.exec(value)
  if (!match) return null

  // Belt and braces: the standard parser must see the same URL too.
  if (!URL.canParse(value) || new URL(value).href !== value) return null

  return { url: value, externalId: Number(match[1]) }
}

// Control characters (a NUL makes PostgreSQL refuse the whole batch) and
// halves of a surrogate pair, which are not valid text on their own.
const UNPRINTABLE = /\p{Cc}/gu

/** Text as a person would see it: trimmed, printable, of bounded length. */
function readText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const text = value
    .toWellFormed()
    .replaceAll('\ufffd', '')
    .replace(UNPRINTABLE, ' ')
    .trim()
  return text === '' ? null : text.slice(0, maxLength)
}

/** A short code such as a SKU or an EAN. Too long means "not a code". */
function readCode(value: unknown): string | null {
  const text = readText(value, MAX_CODE_LENGTH + 1)
  return text !== null && text.length <= MAX_CODE_LENGTH ? text : null
}

/**
 * The product page on the store's own site. The hub never fetches it; it is
 * kept for the plugin, which treats it as untrusted text. It is stored in
 * the parser's normalised form, so no tab, line break or backslash survives.
 */
function readStoreUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (url.username !== '' || url.password !== '') return null
    return url.href.length <= MAX_URL_LENGTH ? url.href : null
  } catch {
    return null
  }
}

export function readSellerOffer(raw: unknown): OfferReading {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'not_an_object' }
  }
  const item = raw as Record<string, unknown>

  const offerRef = readCode(item.productId)
  if (!offerRef) return { ok: false, reason: 'missing_offer_ref' }

  const product = readProductUrl(item.productUrl)
  if (!product) return { ok: false, reason: 'bad_product_url' }

  const ownName = readText(item.productName, MAX_NAME_LENGTH)
  const kkName = readText(item.productNameKK, MAX_NAME_LENGTH)
  if (!ownName && !kkName) return { ok: false, reason: 'missing_name' }

  const storeUrl = readStoreUrl(item.url)
  if (!storeUrl) return { ok: false, reason: 'bad_store_url' }

  const { price, stock } = item
  if (
    typeof price !== 'number'
    || !Number.isFinite(price)
    || price < 0
    || price > MAX_PRICE_EUROS
  ) {
    return { ok: false, reason: 'bad_price' }
  }
  if (
    typeof stock !== 'number'
    || !Number.isInteger(stock)
    || stock < 0
    || stock > MAX_STOCK
  ) {
    return { ok: false, reason: 'bad_stock' }
  }

  return {
    ok: true,
    offer: {
      offerRef,
      productExternalId: product.externalId,
      productUrl: product.url,
      productName: (kkName ?? ownName) as string,
      name: (ownName ?? kkName) as string,
      sku: readCode(item.sku),
      ean: readCode(item.ean),
      storeUrl,
      priceCents: eurosToCents(price),
      stock,
      // Kept as information only: it is not "has the lowest price".
      isTopBox: item.isTopBox === true,
      updatedAt: typeof item.updatedAt === 'string'
        ? lisbonWallTimeToInstant(item.updatedAt)
        : null
    }
  }
}

export interface OffersReading {
  offers: SellerOffer[]
  /** How many items were left out, by reason. Empty when all were usable. */
  skipped: Partial<Record<SkipReason, number>>
}

/**
 * Reads a whole response. A store has one offer per product and one product
 * per offer; if the response repeats either, the first is kept and the rest
 * are counted as duplicates rather than guessed at.
 */
export function readSellerOffers(items: readonly unknown[]): OffersReading {
  const offers: SellerOffer[] = []
  const skipped: Partial<Record<SkipReason, number>> = {}
  const seenRefs = new Set<string>()
  const seenProducts = new Set<number>()

  const skip = (reason: SkipReason) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1
  }

  for (const item of items) {
    const reading = readSellerOffer(item)
    if (!reading.ok) {
      skip(reading.reason)
      continue
    }
    const { offer } = reading
    if (
      seenRefs.has(offer.offerRef)
      || seenProducts.has(offer.productExternalId)
    ) {
      skip('duplicate_in_response')
      continue
    }
    seenRefs.add(offer.offerRef)
    seenProducts.add(offer.productExternalId)
    offers.push(offer)
  }

  return { offers, skipped }
}
