import type { PageOffer } from './page-offers'

/**
 * Finds out which of the stores on KuantoKusta's pages is the hub's own
 * store.
 *
 * Nobody has to type it in. The hub knows the price the store has on each of
 * its offers (from the Seller API) and sees every store's price on each
 * product page. The store is the one whose price on the page equals the
 * store's own price on nearly every page. A competitor matches by
 * coincidence on a few pages, not on most of them.
 */
export interface IdentitySample {
  /** The store's price for this product, according to the Seller API. */
  apiPriceCents: number
  /** Every store's offer on the product's page. */
  offers: readonly PageOffer[]
}

export type IdentityGuess
  = | { kind: 'found', storeSlug: string, sellerId: number | null, pages: number, matches: number }
  /** Too few pages to tell, or no store stands out. */
    | { kind: 'unknown', reason: 'too_few_pages' | 'no_clear_match', pages: number }

// Below this many readable pages a coincidence is too likely.
const MIN_PAGES = 5
// The store's page price can lag behind the API after a price change, so
// "nearly every page" is not "every page".
const MIN_SHARE = 0.6
// The runner-up must be clearly behind, or the answer is not trusted.
const MIN_LEAD = 2

export function guessStoreIdentity(
  samples: readonly IdentitySample[]
): IdentityGuess {
  const pages = samples.filter((sample) => sample.offers.length > 0)
  if (pages.length < MIN_PAGES) {
    return { kind: 'unknown', reason: 'too_few_pages', pages: pages.length }
  }

  // For each store: on how many pages its price equals the store's own.
  const matches = new Map<string, number>()
  const sellerIds = new Map<string, Map<number, number>>()
  for (const { apiPriceCents, offers } of pages) {
    const seen = new Set<string>()
    for (const offer of offers) {
      const slug = offer.storeSlug.toLowerCase()
      if (slug === '' || offer.priceCents !== apiPriceCents || seen.has(slug)) {
        continue
      }
      seen.add(slug)
      matches.set(slug, (matches.get(slug) ?? 0) + 1)
      if (offer.sellerId !== null) {
        const ids = sellerIds.get(slug) ?? new Map<number, number>()
        ids.set(offer.sellerId, (ids.get(offer.sellerId) ?? 0) + 1)
        sellerIds.set(slug, ids)
      }
    }
  }

  const ranked = [...matches.entries()].sort((a, b) => b[1] - a[1])
  const [best, runnerUp] = ranked
  const clear
    = best !== undefined
      && best[1] >= Math.ceil(pages.length * MIN_SHARE)
      && (runnerUp === undefined || best[1] >= runnerUp[1] * MIN_LEAD)
  if (!clear) {
    return { kind: 'unknown', reason: 'no_clear_match', pages: pages.length }
  }

  const [storeSlug, count] = best
  return {
    kind: 'found',
    storeSlug,
    sellerId: mostCommon(sellerIds.get(storeSlug)),
    pages: pages.length,
    matches: count
  }
}

/**
 * The seller id the store's offers carry, once the store is known by its
 * slug. Null when the pages do not agree on one.
 */
export function learnSellerId(
  storeSlug: string,
  pages: readonly (readonly PageOffer[])[]
): number | null {
  const counts = new Map<number, number>()
  for (const offers of pages) {
    for (const offer of offers) {
      if (
        offer.sellerId !== null
        && offer.storeSlug.toLowerCase() === storeSlug.toLowerCase()
      ) {
        counts.set(offer.sellerId, (counts.get(offer.sellerId) ?? 0) + 1)
      }
    }
  }
  return counts.size === 1 ? mostCommon(counts) : null
}

function mostCommon(counts: Map<number, number> | undefined): number | null {
  if (!counts || counts.size === 0) return null
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
}
