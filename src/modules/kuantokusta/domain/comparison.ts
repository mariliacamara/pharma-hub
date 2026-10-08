import type { PageOffer } from './page-offers'

/**
 * Compares a store's price with the other stores listed on a KuantoKusta product page.
 *
 * Pure functions, no I/O. The result maps one to one to the kk_price_comparisons table,
 * and the database re-checks the same rules with CHECK constraints.
 */

export type ComparisonOutcome = 'cheapest' | 'tied' | 'more_expensive' | 'only_store'

/** How the store's own offer is recognised in the page's list. */
export interface StoreIdentity {
  storeSlug: string
  /** KuantoKusta's id for the seller. Preferred over the slug once it is known. */
  sellerId: number | null
}

export interface Comparison {
  outcome: ComparisonOutcome
  /** The price on the page when the store is listed there, otherwise the Seller API price. */
  storePriceCents: number
  storeIsListed: boolean
  /** Lowest price among the OTHER stores; null when there is none. */
  lowestPriceCents: number | null
  lowestStoreName: string | null
  lowestStoreSlug: string | null
  /** storePriceCents - lowestPriceCents. Positive: the store is more expensive. */
  differenceCents: number | null
  /** 1 = cheapest. null when the store is not listed on the page. */
  storePosition: number | null
  storeCount: number
  /** The same comparison including each store's minimum shipping, when the page shows it. */
  storeTotalCents: number | null
  lowestTotalCents: number | null
  lowestTotalStoreName: string | null
}

export interface ComparisonInput {
  /** The store's price according to the Seller API, used when the page does not list the store. */
  apiPriceCents: number
  offers: readonly PageOffer[]
  store: StoreIdentity
}

export function comparePrices({ apiPriceCents, offers, store }: ComparisonInput): Comparison {
  const own = cheapest(offers.filter((offer) => belongsTo(offer, store)))
  const others = offers.filter((offer) => !belongsTo(offer, store))
  const storePriceCents = own?.priceCents ?? apiPriceCents

  const shared = {
    storePriceCents,
    storeIsListed: own !== null,
    storePosition: own
      ? 1 + others.filter((offer) => offer.priceCents < own.priceCents).length
      : null,
    storeCount: offers.length,
    storeTotalCents: own && own.shippingCents !== null ? own.priceCents + own.shippingCents : null
  }

  const lowest = cheapest(others)
  if (!lowest) {
    return {
      ...shared,
      outcome: 'only_store',
      lowestPriceCents: null,
      lowestStoreName: null,
      lowestStoreSlug: null,
      differenceCents: null,
      lowestTotalCents: null,
      lowestTotalStoreName: null
    }
  }

  const differenceCents = storePriceCents - lowest.priceCents
  const lowestTotal = cheapestTotal(others)
  return {
    ...shared,
    outcome: differenceCents > 0 ? 'more_expensive' : differenceCents === 0 ? 'tied' : 'cheapest',
    lowestPriceCents: lowest.priceCents,
    lowestStoreName: lowest.storeName,
    lowestStoreSlug: lowest.storeSlug,
    differenceCents,
    lowestTotalCents: lowestTotal ? lowestTotal.totalCents : null,
    lowestTotalStoreName: lowestTotal ? lowestTotal.offer.storeName : null
  }
}

/**
 * How far the cheaper of the two prices is below the other, as a percentage that keeps
 * the sign of the difference and stays between -100 and 100. Dividing by the store's
 * own price instead gives -160% when the store sells at 0.65 against 1.69.
 */
export function differencePercent(
  comparison: Pick<Comparison, 'storePriceCents' | 'lowestPriceCents' | 'differenceCents'>
): number | null {
  const { storePriceCents, lowestPriceCents, differenceCents } = comparison
  if (lowestPriceCents === null || differenceCents === null) return null
  const higher = Math.max(storePriceCents, lowestPriceCents)
  return higher === 0 ? 0 : (differenceCents / higher) * 100
}

/**
 * The store is more expensive, but by so little that adjusting the price may be worth
 * it. A tie is not an easy adjust: the store already has the lowest price.
 */
export function isEasyAdjust(differenceCents: number | null, thresholdCents: number): boolean {
  return differenceCents !== null && differenceCents > 0 && differenceCents <= thresholdCents
}

/**
 * Matches the store's own offer by seller id when it is known, otherwise by the exact
 * slug. Never by searching for the store's name in free text.
 */
function belongsTo(offer: PageOffer, store: StoreIdentity): boolean {
  if (store.sellerId !== null && offer.sellerId !== null) return offer.sellerId === store.sellerId
  return offer.storeSlug !== '' && offer.storeSlug.toLowerCase() === store.storeSlug.toLowerCase()
}

function cheapest(offers: readonly PageOffer[]): PageOffer | null {
  let best: PageOffer | null = null
  for (const offer of offers) {
    if (!best || offer.priceCents < best.priceCents) best = offer
  }
  return best
}

function cheapestTotal(
  offers: readonly PageOffer[]
): { offer: PageOffer, totalCents: number } | null {
  let best: { offer: PageOffer, totalCents: number } | null = null
  for (const offer of offers) {
    if (offer.shippingCents === null) continue
    const totalCents = offer.priceCents + offer.shippingCents
    if (!best || totalCents < best.totalCents) best = { offer, totalCents }
  }
  return best
}
