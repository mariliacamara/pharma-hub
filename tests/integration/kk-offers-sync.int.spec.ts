import {
  describe,
  beforeAll,
  beforeEach,
  afterAll,
  it,
  expect
} from '@jest/globals'
import { Logger } from '@nestjs/common'

import type { PrismaService } from '#/infra/database/prisma.service'
import { AuditService } from '#/modules/audit/services/audit.service'
import type { CredentialsService } from '#/modules/credentials/services/credentials.service'
import {
  KkCredentialMissingError,
  OffersSyncService
} from '#/modules/kuantokusta/services/offers-sync.service'
import { OffersService } from '#/modules/kuantokusta/services/offers.service'
import {
  KkKeyRejectedError,
  KkUnavailableError,
  KkUnexpectedResponseError
} from '#/modules/kuantokusta/services/seller-api.client'

import { FakeKkServer } from '../support/fake-kk-server'
import { appPrisma, createStore, deleteStores } from './support/database'
import type { TestStore } from './support/database'
import {
  fakeSellerApiClient,
  ProductRange,
  TEST_ACTOR,
  testCredentials
} from './support/kuantokusta'

describe('KuantoKusta offers sync', () => {
  const server = new FakeKkServer()
  const products = new ProductRange()
  let prisma: PrismaService
  let credentials: CredentialsService
  let sync: OffersSyncService
  let offers: OffersService
  let store: TestStore
  let otherStore: TestStore
  const created: TestStore[] = []

  beforeAll(async () => {
    Logger.overrideLogger(false)
    await server.start()
    prisma = appPrisma()
    await prisma.onModuleInit()
    credentials = testCredentials(prisma)
    sync = new OffersSyncService(
      prisma,
      credentials,
      fakeSellerApiClient(server),
      new AuditService()
    )
    offers = new OffersService(prisma)
  })

  afterAll(async () => {
    await deleteStores(prisma, created)
    await products.cleanUp(prisma)
    await prisma.onApplicationShutdown()
    await server.stop()
  })

  const newStore = async (label: string) => {
    const made = await createStore(prisma, label)
    created.push(made)
    await credentials.set(
      { storeId: made.id, provider: 'kuantokusta', secret: server.acceptedKey },
      TEST_ACTOR
    )
    return made
  }

  beforeEach(async () => {
    server.reset()
    store = await newStore('sync')
    otherStore = await newStore('sync-other')
  })

  const stored = async (of: TestStore = store) => {
    const page = await offers.list(of.id, { limit: 200, status: 'all' })
    return page.offers
  }
  const refs = (list: { offerRef: string }[]) =>
    list.map((offer) => offer.offerRef).sort()

  it('copies every offer on the first run', async () => {
    server.offers = Array.from({ length: 150 }, (_, n) => products.offer(n))

    const result = await sync.sync(store.id, TEST_ACTOR)

    expect(result).toMatchObject({
      fetched: 150,
      created: 150,
      updated: 0,
      delisted: 0,
      skipped: {},
      delistingHeldBack: null,
      missing: 0,
      withoutSku: 0,
      withoutEan: 0
    })
    const list = await stored()

    expect(list).toHaveLength(150)
    expect(list.find((offer) => offer.offerRef === 'p-9-30001')).toMatchObject({
      sku: '6800001',
      ean: '5600000000001',
      name: 'Produto de teste 1',
      storeUrl: 'https://loja.example/produto/teste-1/',
      productUrl: `https://www.kuantokusta.pt/p/${products.base + 1}/produto-1`,
      priceCents: 1034,
      stock: 13,
      isTopBox: false,
      listingStatus: 'listed',
      kkUpdatedAt: new Date('2026-10-07T23:49:45.000Z')
    })
  })

  it('changes nothing when run again with the same answer', async () => {
    server.offers = [products.offer(1), products.offer(2)]
    await sync.sync(store.id, TEST_ACTOR)
    const before = await stored()

    const result = await sync.sync(store.id, TEST_ACTOR)
    const after = await stored()

    expect(result).toMatchObject({ created: 0, updated: 2, delisted: 0 })
    const withoutLastSeen = (list: typeof before) =>
      list.map((offer) => ({ ...offer, lastSeenAt: null }))

    expect(withoutLastSeen(after)).toEqual(withoutLastSeen(before))
    expect(after[0].lastSeenAt.getTime()).toBeGreaterThan(
      before[0].lastSeenAt.getTime()
    )
  })

  it('updates price and stock, keeping the same row', async () => {
    server.offers = [products.offer(1)]
    await sync.sync(store.id, TEST_ACTOR)
    const [before] = await stored()

    server.offers = [products.offer(1, { price: 7.5, stock: 0, isTopBox: true })]
    await sync.sync(store.id, TEST_ACTOR)
    const [after] = await stored()

    expect(after).toMatchObject({
      id: before.id,
      priceCents: 750,
      stock: 0,
      isTopBox: true
    })
  })

  it('marks as delisted what the API stopped returning, and relists it later', async () => {
    server.offers = [products.offer(1), products.offer(2), products.offer(3)]
    await sync.sync(store.id, TEST_ACTOR)

    server.offers = [products.offer(1), products.offer(3)]
    const gone = await sync.sync(store.id, TEST_ACTOR)

    expect(gone).toMatchObject({ created: 0, updated: 2, delisted: 1 })
    expect(
      (await stored()).map((offer) => [offer.offerRef, offer.listingStatus])
    ).toEqual([
      ['p-9-30001', 'listed'],
      ['p-9-30002', 'delisted'],
      ['p-9-30003', 'listed']
    ])

    server.offers = [products.offer(1), products.offer(2), products.offer(3)]
    const back = await sync.sync(store.id, TEST_ACTOR)

    expect(back).toMatchObject({ created: 0, updated: 3, delisted: 0 })
    expect((await stored()).every((o) => o.listingStatus === 'listed'))
      .toBe(true)
  })

  it('delists a small store that really has no offers left', async () => {
    server.offers = [products.offer(1), products.offer(2)]
    await sync.sync(store.id, TEST_ACTOR)

    server.offers = []
    const result = await sync.sync(store.id, TEST_ACTOR)

    expect(result).toMatchObject({ fetched: 0, delisted: 2, missing: 2 })
    expect(await offers.count(store.id)).toEqual({ listed: 0, delisted: 2 })
  })

  describe('when a large part of the catalogue is missing from the answer', () => {
    const catalogue = () =>
      Array.from({ length: 60 }, (_, n) => products.offer(n))

    it('holds back if the answer is empty: it looks like a faulty answer', async () => {
      server.offers = catalogue()
      await sync.sync(store.id, TEST_ACTOR)

      server.offers = []
      const result = await sync.sync(store.id, TEST_ACTOR)

      expect(result).toMatchObject({
        fetched: 0,
        delisted: 0,
        missing: 60,
        delistingHeldBack: 'too_many_at_once'
      })
      expect(await offers.count(store.id)).toEqual({ listed: 60, delisted: 0 })
    })

    it('holds back if the answer was cut short', async () => {
      server.offers = catalogue()
      await sync.sync(store.id, TEST_ACTOR)

      // 13 of 60 missing: more than 20% and more than 10.
      server.offers = catalogue().slice(0, 47)
      const result = await sync.sync(store.id, TEST_ACTOR)

      expect(result).toMatchObject({
        updated: 47,
        delisted: 0,
        missing: 13,
        delistingHeldBack: 'too_many_at_once'
      })
    })

    it('lets a normal amount of change through', async () => {
      server.offers = catalogue()
      await sync.sync(store.id, TEST_ACTOR)

      // 12 of 60 missing: exactly 20%.
      server.offers = catalogue().slice(0, 48)
      const result = await sync.sync(store.id, TEST_ACTOR)

      expect(result).toMatchObject({
        delisted: 12,
        missing: 12,
        delistingHeldBack: null
      })
    })

    it('delists them all when a person confirms it', async () => {
      server.offers = catalogue()
      await sync.sync(store.id, TEST_ACTOR)
      server.offers = []
      await sync.sync(store.id, TEST_ACTOR)

      const result = await sync.sync(store.id, TEST_ACTOR, {
        allowMassDelisting: true
      })

      expect(result).toMatchObject({
        delisted: 60,
        missing: 60,
        delistingHeldBack: null
      })
      expect(await offers.count(store.id)).toEqual({ listed: 0, delisted: 60 })
    })

    it('catches up by itself when the next answer is whole again', async () => {
      server.offers = catalogue()
      await sync.sync(store.id, TEST_ACTOR)
      server.offers = []
      await sync.sync(store.id, TEST_ACTOR)

      server.offers = catalogue()
      const result = await sync.sync(store.id, TEST_ACTOR)

      expect(result).toMatchObject({
        updated: 60,
        delisted: 0,
        missing: 0,
        delistingHeldBack: null
      })
    })
  })

  it('survives text that the database would refuse', async () => {
    server.offers = [
      products.offer(1, {
        productName: 'Creme\u0000 com NUL',
        productNameKK: 'Lone surrogate \ud83d here',
        sku: 'SKU\u0000-1'
      })
    ]

    const result = await sync.sync(store.id, TEST_ACTOR)

    expect(result).toMatchObject({ created: 1, skipped: {} })
    expect(await stored()).toMatchObject([
      { name: 'Creme  com NUL', sku: 'SKU -1' }
    ])
  })

  it('skips an unreadable item and, that time, delists nothing', async () => {
    server.offers = [products.offer(1), products.offer(2), products.offer(3)]
    await sync.sync(store.id, TEST_ACTOR)

    // Offer 2 comes back broken, offer 3 does not come back at all.
    server.offers = [products.offer(1), products.offer(2, { price: null })]
    const result = await sync.sync(store.id, TEST_ACTOR)

    expect(result).toMatchObject({
      fetched: 2,
      updated: 1,
      delisted: 0,
      skipped: { bad_price: 1 },
      delistingHeldBack: 'items_skipped',
      missing: 2
    })
    expect(await offers.count(store.id)).toEqual({ listed: 3, delisted: 0 })
  })

  it('stores nothing when no item can be read: the format changed', async () => {
    server.offers = [products.offer(1)]
    await sync.sync(store.id, TEST_ACTOR)

    server.offers = [{ offers: 'moved elsewhere' }, { v: 3 }]

    await expect(sync.sync(store.id, TEST_ACTOR)).rejects.toThrow(
      KkUnexpectedResponseError
    )
    expect(await offers.count(store.id)).toEqual({ listed: 1, delisted: 0 })
  })

  it('follows an offer that moved to another product page', async () => {
    server.offers = [products.offer(1)]
    await sync.sync(store.id, TEST_ACTOR)
    const [before] = await stored()

    server.offers = [
      products.offer(1, {
        productUrl: `https://www.kuantokusta.pt/p/${products.base + 77}/outro`
      })
    ]
    const result = await sync.sync(store.id, TEST_ACTOR)
    const [after] = await stored()

    expect(result).toMatchObject({ created: 0, updated: 1, delisted: 0 })
    expect(after.id).toBe(before.id)
    expect(after.productUrl).toBe(
      `https://www.kuantokusta.pt/p/${products.base + 77}/outro`
    )
  })

  it('follows an offer that got a new reference for the same product', async () => {
    server.offers = [products.offer(1)]
    await sync.sync(store.id, TEST_ACTOR)
    const [before] = await stored()

    server.offers = [products.offer(1, { productId: 'p-9-99999' })]
    const result = await sync.sync(store.id, TEST_ACTOR)

    expect(result).toMatchObject({ created: 0, updated: 1, delisted: 0 })
    expect(await stored()).toMatchObject([
      { id: before.id, offerRef: 'p-9-99999' }
    ])
  })

  it('leaves both rows alone when an offer matches two of them', async () => {
    server.offers = [products.offer(1), products.offer(2)]
    await sync.sync(store.id, TEST_ACTOR)
    const before = await stored()

    // The reference of offer 1 now points at the product of offer 2.
    server.offers = [
      products.offer(1, { productUrl: products.offer(2).productUrl })
    ]
    const result = await sync.sync(store.id, TEST_ACTOR)

    expect(result).toMatchObject({
      created: 0,
      updated: 0,
      delisted: 0,
      skipped: { conflicting_identity: 1 },
      delistingHeldBack: 'items_skipped'
    })
    expect(refs(await stored())).toEqual(refs(before))
  })

  it('writes nothing when a later page fails', async () => {
    server.offers = Array.from({ length: 150 }, (_, n) => products.offer(n))
    server.queued.push((response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(server.offers.slice(0, 100)))
    })
    server.failNext(3, 503)

    await expect(sync.sync(store.id, TEST_ACTOR)).rejects.toThrow(
      KkUnavailableError
    )
    expect(await stored()).toEqual([])
  })

  it('reports a store without a key, and a key KuantoKusta refuses', async () => {
    const keyless = await createStore(prisma, 'sync-keyless')
    created.push(keyless)

    await expect(sync.sync(keyless.id, TEST_ACTOR)).rejects.toThrow(
      KkCredentialMissingError
    )
    expect(server.requests).toEqual([])

    server.acceptedKey = 'the-key-was-rotated-at-kuantokusta'

    await expect(sync.sync(store.id, TEST_ACTOR)).rejects.toThrow(
      KkKeyRejectedError
    )
  })

  it('keeps two stores that sell the same product apart', async () => {
    server.offers = [products.offer(1), products.offer(2)]
    await sync.sync(store.id, TEST_ACTOR)
    server.offers = [
      products.offer(1, { productId: 'p-7-11111', price: 5, sku: 'OTHER-1' })
    ]
    await sync.sync(otherStore.id, TEST_ACTOR)

    expect(refs(await stored(store))).toEqual(['p-9-30001', 'p-9-30002'])
    expect(await stored(otherStore)).toMatchObject([
      { offerRef: 'p-7-11111', priceCents: 500, sku: 'OTHER-1' }
    ])
    // One shared product row serves both stores.
    const shared = await prisma.kk_products.findMany({
      where: { external_id: products.base + 1 }
    })

    expect(shared).toHaveLength(1)

    // A sync of one store never delists the other store's offers.
    server.offers = []
    await sync.sync(otherStore.id, TEST_ACTOR)

    expect(await offers.count(store.id)).toEqual({ listed: 2, delisted: 0 })
    expect(await offers.count(otherStore.id)).toEqual({ listed: 0, delisted: 1 })
  })

  it('gives the same result when two syncs of a store run at once', async () => {
    server.offers = Array.from({ length: 120 }, (_, n) => products.offer(n))

    const results = await Promise.all([
      sync.sync(store.id, TEST_ACTOR),
      sync.sync(store.id, TEST_ACTOR),
      sync.sync(store.id, TEST_ACTOR)
    ])

    expect(results.map((result) => result.created).sort()).toEqual([0, 0, 120])
    expect(results.every((result) => result.delisted === 0)).toBe(true)
    expect(await offers.count(store.id)).toEqual({ listed: 120, delisted: 0 })
  })

  it('does not deadlock when two stores sync the same products at once', async () => {
    const forward = Array.from({ length: 200 }, (_, n) => products.offer(n))
    server.offers = forward
    const first = sync.sync(store.id, TEST_ACTOR)
    // The other store receives the same products in the opposite order.
    server.offers = [...forward].reverse()
    const second = sync.sync(otherStore.id, TEST_ACTOR)

    const results = await Promise.all([first, second])

    expect(results.map((result) => result.created)).toEqual([200, 200])
  })

  it('pages through the stored offers without losing or repeating one', async () => {
    server.offers = Array.from({ length: 25 }, (_, n) => products.offer(n))
    await sync.sync(store.id, TEST_ACTOR)

    const seen: string[] = []
    let after: bigint | undefined
    let pages = 0
    do {
      const page = await offers.list(store.id, {
        limit: 10,
        after,
        status: 'listed'
      })
      seen.push(...page.offers.map((offer) => offer.offerRef))
      after = page.nextCursor === null ? undefined : BigInt(page.nextCursor)
      pages++
    } while (after !== undefined)

    expect(pages).toBe(3)
    expect(seen).toHaveLength(25)
    expect(new Set(seen).size).toBe(25)
  })

  it('records each sync in the audit log', async () => {
    server.offers = [products.offer(1), products.offer(2, { stock: -1 })]
    await sync.sync(store.id, TEST_ACTOR)

    const [event] = await prisma.audit_events.findMany({
      where: { store_id: store.id, action: 'kk_offers.synced' }
    })

    expect(event).toMatchObject({
      actor_type: 'system',
      details: {
        created: 1,
        updated: 0,
        delisted: 0,
        missing: 0,
        skipped: { bad_stock: 1 },
        delistingHeldBack: 'items_skipped',
        massDelistingAllowed: false
      }
    })
    expect(JSON.stringify(event.details)).not.toContain(server.acceptedKey)
  })
})
