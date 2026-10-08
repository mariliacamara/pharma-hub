import { describe, it, expect } from '@jest/globals'

import { planOfferSync } from '#/modules/kuantokusta/domain/offer-sync-plan'
import type { StoredOffer } from '#/modules/kuantokusta/domain/offer-sync-plan'
import { readSellerOffer } from '#/modules/kuantokusta/domain/seller-offer'
import type { SellerOffer } from '#/modules/kuantokusta/domain/seller-offer'

import { fakeOffer } from '../../../../support/fake-kk-server'

function offer(ref: string, product: number): SellerOffer {
  const reading = readSellerOffer(
    fakeOffer(1, {
      productId: ref,
      productUrl: `https://www.kuantokusta.pt/p/${product}/x`
    })
  )
  if (!reading.ok) throw new Error(reading.reason)
  return reading.offer
}

const stored = (id: number, ref: string, product: number): StoredOffer => ({
  id: BigInt(id),
  offerRef: ref,
  productExternalId: product
})

const summary = (plan: ReturnType<typeof planOfferSync>) => ({
  inserts: plan.inserts.map((o) => o.offerRef),
  updates: plan.updates.map((u) => `${u.id}<-${u.offer.offerRef}`),
  conflicts: plan.conflicts.map((o) => o.offerRef)
})

describe('planOfferSync', () => {
  it('inserts what is new and updates what is known', () => {
    const plan = planOfferSync(
      [stored(1, 'a', 100), stored(2, 'b', 200)],
      [offer('a', 100), offer('c', 300)]
    )

    expect(summary(plan)).toEqual({
      inserts: ['c'],
      updates: ['1<-a'],
      conflicts: []
    })
  })

  it('recognises an offer that moved to another product page', () => {
    const plan = planOfferSync([stored(1, 'a', 100)], [offer('a', 999)])

    expect(summary(plan)).toEqual({
      inserts: [],
      updates: ['1<-a'],
      conflicts: []
    })
    expect(plan.updates[0].offer.productExternalId).toBe(999)
  })

  it('recognises an offer that got a new reference for the same product', () => {
    const plan = planOfferSync([stored(1, 'a', 100)], [offer('z', 100)])

    expect(summary(plan)).toEqual({
      inserts: [],
      updates: ['1<-z'],
      conflicts: []
    })
  })

  it('leaves alone an offer that matches two different stored rows', () => {
    const plan = planOfferSync(
      [stored(1, 'a', 100), stored(2, 'b', 200)],
      [offer('a', 200)]
    )

    expect(summary(plan)).toEqual({
      inserts: [],
      updates: [],
      conflicts: ['a']
    })
  })

  it('never updates one stored row from two incoming offers', () => {
    const plan = planOfferSync(
      [stored(1, 'a', 100)],
      [offer('a', 500), offer('q', 100)]
    )

    expect(summary(plan)).toEqual({
      inserts: [],
      updates: ['1<-a'],
      conflicts: ['q']
    })
  })

  it('handles an empty side', () => {
    expect(summary(planOfferSync([], [offer('a', 1)]))).toEqual({
      inserts: ['a'],
      updates: [],
      conflicts: []
    })
    expect(summary(planOfferSync([stored(1, 'a', 1)], []))).toEqual({
      inserts: [],
      updates: [],
      conflicts: []
    })
  })
})
