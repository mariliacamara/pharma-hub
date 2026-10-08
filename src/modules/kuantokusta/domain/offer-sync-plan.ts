import type { SellerOffer } from './seller-offer'

/** An offer the hub already holds for the store. */
export interface StoredOffer {
  id: bigint
  offerRef: string
  productExternalId: number
}

export interface OfferSyncPlan {
  inserts: SellerOffer[]
  updates: { id: bigint, offer: SellerOffer }[]
  /**
   * Offers that match two different stored rows at once: one by reference,
   * another by product. Applying either would break the other, so they are
   * left untouched and reported.
   */
  conflicts: SellerOffer[]
}

/**
 * Decides, for each offer the API returned, whether it is new or which
 * stored row it updates.
 *
 * A stored offer has two identities, both unique per store: the offer
 * reference and the product. KuantoKusta can change either (an offer moved
 * to the right product page keeps its reference; a re-created offer keeps
 * its product), so a match on one of them is enough to recognise the row,
 * and the row then takes the new value of the other.
 */
export function planOfferSync(
  stored: readonly StoredOffer[],
  incoming: readonly SellerOffer[]
): OfferSyncPlan {
  const byRef = new Map(stored.map((row) => [row.offerRef, row]))
  const byProduct = new Map(stored.map((row) => [row.productExternalId, row]))

  const plan: OfferSyncPlan = { inserts: [], updates: [], conflicts: [] }
  const claimed = new Set<bigint>()

  for (const offer of incoming) {
    const sameRef = byRef.get(offer.offerRef)
    const sameProduct = byProduct.get(offer.productExternalId)

    if (sameRef && sameProduct && sameRef.id !== sameProduct.id) {
      plan.conflicts.push(offer)
      continue
    }

    const row = sameRef ?? sameProduct
    if (!row) {
      plan.inserts.push(offer)
    } else if (claimed.has(row.id)) {
      // Two incoming offers resolve to the same stored row.
      plan.conflicts.push(offer)
    } else {
      claimed.add(row.id)
      plan.updates.push({ id: row.id, offer })
    }
  }

  return plan
}
