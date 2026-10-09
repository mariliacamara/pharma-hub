import {
  describe,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  it,
  expect
} from '@jest/globals'
import { Logger } from '@nestjs/common'

import type { PrismaService } from '#/infra/database/prisma.service'
import { AuditService } from '#/modules/audit/services/audit.service'
import type { CredentialsService } from '#/modules/credentials/services/credentials.service'
import {
  CollectionRunsService,
  RunTooSoonError
} from '#/modules/kuantokusta/services/collection-runs.service'
import type { Claim } from '#/modules/kuantokusta/services/collection-runs.service'
import { CollectionScheduler } from '#/modules/kuantokusta/services/collection.scheduler'
import { CollectionService } from '#/modules/kuantokusta/services/collection.service'
import type {
  CollectionControl,
  CollectionTimings
} from '#/modules/kuantokusta/services/collection.service'
import { CollectionWorker } from '#/modules/kuantokusta/services/collection.worker'
import { KkCredentialService } from '#/modules/kuantokusta/services/kk-credential.service'
import { KkStoreSettingsService } from '#/modules/kuantokusta/services/kk-store-settings.service'
import { OffersSyncService } from '#/modules/kuantokusta/services/offers-sync.service'
import { ProductPageClient } from '#/modules/kuantokusta/services/product-page.client'

import { FakeKkServer } from '../support/fake-kk-server'
import { CHALLENGE_HTML, FakeKkSite } from '../support/fake-kk-site'
import type { SiteOffer } from '../support/fake-kk-site'
import {
  appPrisma,
  createStore,
  deleteStores,
  onlyStores
} from './support/database'
import type { TestStore } from './support/database'
import {
  fakeSellerApiClient,
  ProductRange,
  TEST_ACTOR,
  testCredentials
} from './support/kuantokusta'

const USER_AGENT = 'PharmaHubPriceReport/1.0 (integration test)'
// No pause between pages: the pause is tested on its own.
const FAST: CollectionTimings = {
  pageIntervalMs: 0,
  reuseReadingsForMs: 2 * 60 * 60_000
}

const steady = (): CollectionControl => ({
  stopRequested: false,
  signal: new AbortController().signal
})

/** The store's price for product `n`, in euros and in cents. */
const euros = (n: number) => 10 + n
const cents = (n: number) => euros(n) * 100

// A whole collection against a fake Seller API, a fake KuantoKusta website
// and a real database.
describe('KuantoKusta price collection', () => {
  const server = new FakeKkServer()
  const site = new FakeKkSite()
  const products = new ProductRange()
  let prisma: PrismaService
  let hub: PrismaService
  let credentials: CredentialsService
  let runs: CollectionRunsService
  let settings: KkStoreSettingsService
  let offersSync: OffersSyncService
  let pages: ProductPageClient
  let collection: CollectionService
  let store: TestStore
  let created: TestStore[] = []

  const newCollection = (timings: CollectionTimings = FAST) =>
    new CollectionService(prisma, runs, offersSync, settings, pages, timings)

  beforeAll(async () => {
    Logger.overrideLogger(false)
    await server.start()
    await site.start()
    prisma = appPrisma()
    await prisma.onModuleInit()
    credentials = testCredentials(prisma)
    // The queue and the schedule see only this file's stores.
    hub = onlyStores(prisma, () => created)
    runs = new CollectionRunsService(hub, new AuditService())
    settings = new KkStoreSettingsService(prisma)
    offersSync = new OffersSyncService(
      prisma,
      credentials,
      fakeSellerApiClient(server),
      new AuditService()
    )
    pages = new ProductPageClient({ baseUrl: site.url, userAgent: USER_AGENT })
    collection = newCollection()
  })

  afterAll(async () => {
    await prisma.onModuleDestroy()
    await server.stop()
    await site.stop()
  })

  const newStore = async (label: string, withKey = true) => {
    const made = await createStore(prisma, label)
    created.push(made)
    if (withKey) {
      await credentials.set(
        { storeId: made.id, provider: 'kuantokusta', secret: server.acceptedKey },
        TEST_ACTOR
      )
    }
    return made
  }

  beforeEach(async () => {
    server.reset()
    site.reset()
    store = await newStore('collect')
  })

  afterEach(async () => {
    // Stores first: their offers hold on to the products. Then the products,
    // which takes the stored readings with it, so no test reuses another's.
    await deleteStores(prisma, created)
    created = []
    await products.cleanUp(prisma)
  })

  const own = (n: number, price = euros(n)): SiteOffer => ({
    storeName: 'Zincomed',
    storeSlug: 'zincomed',
    sellerId: 77,
    price
  })
  const rival = (price: number, slug = 'farmacia-b', sellerId = 5): SiteOffer => ({
    storeName: `Loja ${slug}`,
    storeSlug: slug,
    sellerId,
    price,
    shipping: 2.5
  })

  /**
   * `count` offers in the Seller API, and a page for each on the website
   * where the store has its own price and a rival is one euro cheaper.
   */
  const catalogue = (count: number) => {
    server.offers = Array.from({ length: count }, (_, i) =>
      products.offer(i + 1, { price: euros(i + 1) })
    )
    for (let n = 1; n <= count; n++) {
      site.page(products.base + n, [own(n), rival(euros(n) - 1)])
    }
  }
  const pagePath = (n: number) => `/p/${products.base + n}/produto-${n}`

  const request = async (of: TestStore = store) =>
    (await runs.request(of.id, { trigger: 'schedule' }, TEST_ACTOR)).run

  /** Asks for a run, takes it and carries it out. */
  const collect = async (
    of: TestStore = store,
    control: CollectionControl = steady(),
    service: CollectionService = collection
  ) => {
    const asked = await request(of)
    const claim = await runs.claimNext()
    if (claim?.runId !== asked.id) throw new Error('The run was not claimed')
    const end = await service.execute(claim, control)
    const run = await runs.get(of.id, asked.id)
    if (!run) throw new Error('The run disappeared')
    return { end, run, claim }
  }

  const comparisons = (of: TestStore, runId: string) =>
    prisma.withStore(of.id, (tx) =>
      tx.kk_price_comparisons.findMany({
        where: { run_id: runId },
        orderBy: { store_offer_id: 'asc' }
      })
    )

  const snapshots = () =>
    prisma.kk_page_snapshots.findMany({
      where: {
        kk_products: {
          external_id: { gte: products.base, lt: products.base + 10_000 }
        }
      },
      orderBy: { id: 'asc' }
    })

  /** Moves every time of a run into the past, keeping their order. */
  const age = (of: TestStore, runId: string, minutes: number) =>
    prisma.withStore(of.id, (tx) =>
      tx.$executeRaw`
        UPDATE job_runs
           SET queued_at = queued_at - make_interval(mins => ${minutes}::int),
               started_at = started_at - make_interval(mins => ${minutes}::int),
               heartbeat_at = heartbeat_at - make_interval(mins => ${minutes}::int),
               finished_at = finished_at - make_interval(mins => ${minutes}::int)
         WHERE id = ${runId}::uuid`
    )

  const rawRun = (of: TestStore, runId: string) =>
    prisma.withStore(of.id, (tx) =>
      tx.job_runs.findUniqueOrThrow({ where: { id: runId } })
    )

  describe('a whole collection', () => {
    it('reads every page once and compares the store with the others', async () => {
      catalogue(8)
      // Product 1: the store is the cheapest. Product 2: tied. Product 3:
      // nobody else sells it. The others keep a rival one euro cheaper.
      site.page(products.base + 1, [own(1), rival(euros(1) + 2)])
      site.page(products.base + 2, [own(2), rival(euros(2))])
      site.page(products.base + 3, [own(3)])

      const { end, run } = await collect()

      expect(end).toBe('finished')
      expect(run).toMatchObject({
        status: 'succeeded',
        trigger: 'schedule',
        itemsTotal: 8,
        itemsOk: 8,
        itemsFailed: 0,
        errorCode: null
      })
      expect(run.finishedAt).not.toBeNull()

      // robots.txt first, then each product page exactly once, always
      // saying who is reading.
      expect(site.requests.map((entry) => entry.path)).toEqual([
        '/robots.txt',
        ...Array.from({ length: 8 }, (_, i) => pagePath(i + 1))
      ])
      expect(new Set(site.requests.map((entry) => entry.userAgent))).toEqual(
        new Set([USER_AGENT])
      )

      const rows = await comparisons(store, run.id)

      expect(rows.map((row) => row.outcome)).toEqual([
        'cheapest',
        'tied',
        'only_store',
        'more_expensive',
        'more_expensive',
        'more_expensive',
        'more_expensive',
        'more_expensive'
      ])
      expect(rows[0]).toMatchObject({
        store_price_cents: cents(1),
        store_is_listed: true,
        lowest_price_cents: cents(1) + 200,
        lowest_store_slug: 'farmacia-b',
        difference_cents: -200,
        store_position: 1,
        store_count: 2
      })
      expect(rows[3]).toMatchObject({
        store_price_cents: cents(4),
        lowest_price_cents: cents(4) - 100,
        lowest_store_name: 'Loja farmacia-b',
        difference_cents: 100,
        store_position: 2,
        store_count: 2
      })
      expect(rows[2]).toMatchObject({
        outcome: 'only_store',
        lowest_price_cents: null,
        difference_cents: null,
        store_count: 1
      })
      expect(rows.every((row) => row.snapshot_id !== null)).toBe(true)
      expect(await runs.summary(store.id, run.id)).toEqual({
        cheapest: 1,
        tied: 1,
        more_expensive: 5,
        only_store: 1,
        no_data: 0
      })
    })

    it('works out by itself which store on the pages is the hub\'s', async () => {
      catalogue(6)

      expect(await settings.get(store.id)).toBeNull()

      await collect()

      expect(await settings.get(store.id)).toEqual({
        identity: { storeSlug: 'zincomed', sellerId: 77 },
        easyAdjustCents: 10
      })
    })

    it('reads only the offers that are listed and in stock', async () => {
      catalogue(7)
      server.offers = server.offers.map((offer, i) =>
        i === 1 ? { ...(offer as object), stock: 0 } : offer
      )

      const { run } = await collect()

      expect(run).toMatchObject({ status: 'succeeded', itemsTotal: 6 })
      expect(site.pageRequests).not.toContain(pagePath(2))
      expect(await comparisons(store, run.id)).toHaveLength(6)
    })

    it('has nothing to do, and says so, for a store without offers', async () => {
      const { run } = await collect()

      expect(run).toMatchObject({
        status: 'succeeded',
        itemsTotal: 0,
        itemsOk: 0,
        itemsFailed: 0
      })
      expect(site.requests).toEqual([])
    })

    it('uses the price on the page when it differs from the Seller API', async () => {
      catalogue(6)
      // The page still shows yesterday's price for product 6.
      site.page(products.base + 6, [own(6, 15.5), rival(15)])

      const { run } = await collect()
      const rows = await comparisons(store, run.id)

      expect(rows[5]).toMatchObject({
        outcome: 'more_expensive',
        store_price_cents: 1550,
        lowest_price_cents: 1500,
        difference_cents: 50
      })
    })

    it('compares with the Seller API price when the store is not on the page', async () => {
      catalogue(6)
      site.page(products.base + 6, [rival(20)])

      const { run } = await collect()
      const rows = await comparisons(store, run.id)

      expect(rows[5]).toMatchObject({
        outcome: 'cheapest',
        store_is_listed: false,
        store_price_cents: cents(6),
        lowest_price_cents: 2000,
        store_position: null
      })
    })
  })

  describe('pages that cannot be read', () => {
    it('finishes as partial, and still records the store\'s own price', async () => {
      catalogue(9)
      site.pageStatus(products.base + 2, 404)
      site.pageStatus(products.base + 4, 500)
      site.pageHtml(products.base + 6, '<html><title>Produto</title></html>')
      site.pageDrop(products.base + 8)

      const { run } = await collect()

      expect(run).toMatchObject({
        status: 'partial',
        itemsTotal: 9,
        itemsOk: 5,
        itemsFailed: 4,
        errorCode: null
      })
      const rows = await comparisons(store, run.id)

      expect(rows.map((row) => row.outcome)).toEqual([
        'more_expensive',
        'no_data',
        'more_expensive',
        'no_data',
        'more_expensive',
        'no_data',
        'more_expensive',
        'no_data',
        'more_expensive'
      ])
      expect(rows[1]).toMatchObject({
        store_price_cents: cents(2),
        store_is_listed: null,
        lowest_price_cents: null,
        store_count: null
      })
      expect((await snapshots()).map((row) => [row.outcome, row.http_status]))
        .toEqual([
          ['ok', 200],
          ['not_found', 404],
          ['ok', 200],
          ['http_error', 500],
          ['ok', 200],
          ['no_offer_list', 200],
          ['ok', 200],
          ['network_error', null],
          ['ok', 200]
        ])
    })

    it('stops after three refusals in a row and never insists', async () => {
      catalogue(12)
      for (let n = 7; n <= 12; n++) site.pageStatus(products.base + n, 403)

      const { run } = await collect()

      expect(run).toMatchObject({
        status: 'blocked',
        errorCode: 'blocked_by_site',
        itemsTotal: 12,
        itemsOk: 6,
        itemsFailed: 3
      })
      // Six pages read, three refused, and not one request more.
      expect(site.pageRequests).toHaveLength(9)
      expect(site.pageRequests.at(-1)).toBe(pagePath(9))

      const rows = await comparisons(store, run.id)

      // What was read before the block is still compared; the pages never
      // reached are not mentioned.
      expect(rows.map((row) => row.outcome)).toEqual([
        ...Array.from({ length: 6 }, () => 'more_expensive'),
        'no_data',
        'no_data',
        'no_data'
      ])
    })

    it('takes a challenge page for a refusal, whatever its status', async () => {
      catalogue(8)
      for (let n = 6; n <= 8; n++) {
        site.pageHtml(products.base + n, CHALLENGE_HTML)
      }

      const { run } = await collect()

      expect(run).toMatchObject({
        status: 'blocked',
        errorCode: 'blocked_by_site'
      })
    })

    it('carries on when refusals are not in a row', async () => {
      catalogue(12)
      for (const n of [2, 3, 5, 6, 8, 9]) {
        site.pageStatus(products.base + n, 429)
      }

      const { run } = await collect()

      expect(run).toMatchObject({
        status: 'partial',
        itemsOk: 6,
        itemsFailed: 6
      })
      expect(site.pageRequests).toHaveLength(12)
    })

    it('does not read again, in a later run, a page it was refused', async () => {
      catalogue(6)
      site.pageStatus(products.base + 6, 403)

      const first = await collect()

      expect(first.run.status).toBe('partial')

      // A refusal says something about that attempt, not about the page:
      // the next run tries that one page again, and only that one.
      site.requests = []
      site.page(products.base + 6, [own(6), rival(euros(6) - 1)])
      const second = await collect()

      expect(second.run).toMatchObject({ status: 'succeeded', itemsOk: 6 })
      expect(site.pageRequests).toEqual([pagePath(6)])
    })
  })

  describe('robots.txt', () => {
    it('reads nothing when robots.txt disallows the product pages', async () => {
      catalogue(6)
      site.robots = 'User-agent: *\nDisallow: /p/\n'

      const { run } = await collect()

      expect(run).toMatchObject({
        status: 'blocked',
        errorCode: 'robots_refused',
        itemsOk: 0,
        itemsFailed: 6
      })
      expect(site.requests.map((entry) => entry.path)).toEqual(['/robots.txt'])
    })

    it('obeys a rule written for this client by name', async () => {
      catalogue(6)
      site.robots
        = 'User-agent: *\nAllow: /\n\n'
          + 'User-agent: PharmaHubPriceReport\nDisallow: /\n'

      const { run } = await collect()

      expect(run.errorCode).toBe('robots_refused')
      expect(site.pageRequests).toEqual([])
    })

    it('skips only the pages robots.txt disallows', async () => {
      catalogue(6)
      // The real file disallows addresses ending in a hyphen.
      site.robots = 'User-agent: *\nDisallow: /*-$\n'
      server.offers[5] = products.offer(6, {
        price: euros(6),
        productUrl: `https://www.kuantokusta.pt/p/${products.base + 6}/produto-`
      })

      const { run } = await collect()

      expect(run).toMatchObject({
        status: 'partial',
        itemsOk: 5,
        itemsFailed: 1
      })
      expect(site.pageRequests).toHaveLength(5)
      const rows = await comparisons(store, run.id)

      expect(rows[5]).toMatchObject({ outcome: 'no_data', snapshot_id: null })
    })

    it.each([
      [{ status: 403 }, 'blocked', 'robots_refused'],
      [{ status: 401 }, 'blocked', 'robots_refused'],
      [{ status: 500 }, 'failed', 'robots_unavailable'],
      [{ status: 429 }, 'failed', 'robots_unavailable'],
      ['drop' as const, 'failed', 'robots_unavailable'],
      ['User-agent: *\nCrawl-delay: 600\n', 'failed', 'crawl_delay_too_long']
    ])(
      'reads no page when robots.txt answers %j',
      async (robots, status, errorCode) => {
        catalogue(6)
        site.robots = robots

        const { run } = await collect()

        expect(run).toMatchObject({ status, errorCode, itemsOk: 0 })
        expect(site.pageRequests).toEqual([])
        expect(await comparisons(store, run.id)).toEqual([])
      }
    )

    it('reads the pages when there is no robots.txt at all', async () => {
      catalogue(6)
      site.robots = { status: 404 }

      expect((await collect()).run.status).toBe('succeeded')
    })

    it('waits between pages at least as long as robots.txt asks', async () => {
      catalogue(2)
      site.robots = 'User-agent: *\nCrawl-delay: 1\n'
      const times: number[] = []
      site.onPage = () => times.push(Date.now())

      // The interval of the service is zero here, so any wait is robots'.
      await collect()

      expect(times).toHaveLength(2)
      // One second, give or take the 20% of jitter.
      expect(times[1] - times[0]).toBeGreaterThanOrEqual(790)
    })
  })

  describe('the Seller API', () => {
    it('fails, without touching the website, when the key is refused', async () => {
      catalogue(6)
      server.acceptedKey = 'another-key-entirely'

      const { run } = await collect()

      expect(run).toMatchObject({
        status: 'failed',
        errorCode: 'kk_key_rejected',
        itemsTotal: 0
      })
      expect(site.requests).toEqual([])
    })

    it('fails when the store has no key', async () => {
      const keyless = await newStore('keyless', false)

      const { run } = await collect(keyless)

      expect(run).toMatchObject({ status: 'failed', errorCode: 'kk_key_missing' })
    })

    it('fails when KuantoKusta is away', async () => {
      catalogue(6)
      server.failNext(10, 503)

      const { run } = await collect()

      expect(run).toMatchObject({ status: 'failed', errorCode: 'kk_unavailable' })
      expect(site.requests).toEqual([])
    })

    it('compares with the prices of this run, not of an earlier copy', async () => {
      catalogue(6)
      await collect()

      // The store lowers product 1 to match the rival. The page read a
      // moment ago still shows the old price for the store.
      server.offers[0] = products.offer(1, { price: euros(1) - 1 })
      site.page(products.base + 1, [rival(euros(1) - 1)])
      await prisma.kk_page_snapshots.deleteMany({
        where: { kk_products: { external_id: products.base + 1 } }
      })
      const { run } = await collect()
      const rows = await comparisons(store, run.id)

      expect(rows[0]).toMatchObject({
        outcome: 'tied',
        store_price_cents: cents(1) - 100
      })
    })
  })

  describe('readings are reused', () => {
    it('does not read again a page read a moment ago', async () => {
      catalogue(6)
      const first = await collect()
      site.requests = []

      const second = await collect()

      expect(second.run).toMatchObject({ status: 'succeeded', itemsOk: 6 })
      // Not even robots.txt: there was nothing to ask permission for.
      expect(site.requests).toEqual([])
      const [before, after] = await Promise.all([
        comparisons(store, first.run.id),
        comparisons(store, second.run.id)
      ])

      expect(after.map((row) => row.snapshot_id)).toEqual(
        before.map((row) => row.snapshot_id)
      )
      expect(await snapshots()).toHaveLength(6)
    })

    it('reads again once the reading is too old', async () => {
      catalogue(6)
      await collect()
      site.requests = []

      await collect(store, steady(), newCollection({ ...FAST, reuseReadingsForMs: 0 }))

      expect(site.pageRequests).toHaveLength(6)
      expect(await snapshots()).toHaveLength(12)
    })

    it('serves a second store that sells the same products, each with its own result', async () => {
      catalogue(6)
      const first = await collect()
      site.requests = []

      // The second store sells the same products at its own prices, and is
      // on the pages as the rival.
      const second = await newStore('second')
      server.offers = server.offers.map((offer, i) => ({
        ...(offer as object),
        price: euros(i + 1) - 1
      }))
      const other = await collect(second)

      expect(other.run).toMatchObject({ status: 'succeeded', itemsOk: 6 })
      expect(site.requests).toEqual([])
      expect(await settings.get(second.id)).toMatchObject({
        identity: { storeSlug: 'farmacia-b', sellerId: 5 }
      })
      const rows = await comparisons(second, other.run.id)

      expect(rows.map((row) => row.outcome)).toEqual(
        Array.from({ length: 6 }, () => 'cheapest')
      )
      // Each store sees its own comparisons and nothing of the other's.
      expect(await comparisons(second, first.run.id)).toEqual([])
      expect(await comparisons(store, other.run.id)).toEqual([])
      expect(await runs.get(second.id, first.run.id)).toBeNull()
      expect(await runs.summary(second.id, first.run.id)).toEqual({
        cheapest: 0,
        tied: 0,
        more_expensive: 0,
        only_store: 0,
        no_data: 0
      })
    })
  })

  describe('which store is the hub\'s', () => {
    it('does not guess from too few pages, and compares nothing', async () => {
      catalogue(4)

      const { run } = await collect()

      expect(run).toMatchObject({
        status: 'failed',
        errorCode: 'store_identity_unknown',
        itemsOk: 4
      })
      expect(await settings.get(store.id)).toBeNull()
      expect(await comparisons(store, run.id)).toEqual([])
    })

    it('uses what an operator set, without reading the pages again', async () => {
      catalogue(4)
      await collect()
      site.requests = []

      await settings.setIdentity(store.id, { storeSlug: 'zincomed' })
      const { run } = await collect()

      expect(run).toMatchObject({ status: 'succeeded', itemsOk: 4 })
      expect(site.requests).toEqual([])
      expect(await comparisons(store, run.id)).toHaveLength(4)
      // The steadier key was learned from the pages on the way.
      expect((await settings.get(store.id))?.identity).toEqual({
        storeSlug: 'zincomed',
        sellerId: 77
      })
    })

    it('does not guess when no store has the hub\'s prices', async () => {
      catalogue(6)
      for (let n = 1; n <= 6; n++) {
        site.page(products.base + n, [rival(euros(n) + n), rival(3, 'outra', 6)])
      }

      const { run } = await collect()

      expect(run.errorCode).toBe('store_identity_unknown')
    })

    it('never gives two stores of the hub the same identity', async () => {
      catalogue(6)
      await collect()

      // A second store with the very same prices would be "recognised" as
      // the first one.
      const twin = await newStore('twin')
      const { run } = await collect(twin)

      expect(run).toMatchObject({
        status: 'failed',
        errorCode: 'store_identity_conflict'
      })
      expect(await settings.get(twin.id)).toBeNull()
      expect(await comparisons(twin, run.id)).toEqual([])
    })

    it('keeps the name and drops a seller id that is not a usable number', async () => {
      catalogue(6)
      for (let n = 1; n <= 6; n++) {
        site.page(products.base + n, [
          { ...own(n), sellerId: 9_000_000_000 },
          rival(euros(n) - 1)
        ])
      }

      const { run } = await collect()

      expect(run.status).toBe('succeeded')
      expect((await settings.get(store.id))?.identity).toEqual({
        storeSlug: 'zincomed',
        sellerId: null
      })
    })

    it('does not accept as a name something that is not one', async () => {
      catalogue(6)
      for (let n = 1; n <= 6; n++) {
        site.page(products.base + n, [
          { ...own(n), storeSlug: '../../etc <script>' },
          rival(euros(n) - 1)
        ])
      }

      const { run } = await collect()

      expect(run).toMatchObject({
        status: 'failed',
        errorCode: 'store_identity_unknown'
      })
      expect(await settings.get(store.id)).toBeNull()
    })
  })

  describe('interruptions', () => {
    it('goes back to the queue when asked to stop, and later reads only the rest', async () => {
      catalogue(8)
      const stopping = new AbortController()
      const control = {
        stopRequested: false,
        signal: stopping.signal
      }
      let read = 0
      site.onPage = () => {
        if (++read === 3) {
          control.stopRequested = true
          stopping.abort()
        }
      }

      const interrupted = await collect(store, control)

      expect(interrupted.end).toBe('requeued')
      expect(interrupted.run).toMatchObject({
        status: 'queued',
        startedAt: null,
        finishedAt: null,
        itemsTotal: 0
      })
      // Being asked to stop is not the run's fault.
      expect((await rawRun(store, interrupted.run.id)).attempts).toBe(0)
      expect(await snapshots()).toHaveLength(3)

      // The same run is taken up again.
      site.onPage = undefined
      const claim = await runs.claimNext()

      expect(claim).toMatchObject({ runId: interrupted.run.id, attempt: 1 })

      await collection.execute(claim as Claim, steady())
      const run = await runs.get(store.id, interrupted.run.id)

      expect(run).toMatchObject({ status: 'succeeded', itemsOk: 8 })
      // Eight pages in all, none of them twice.
      expect(site.pageRequests).toEqual(
        Array.from({ length: 8 }, (_, i) => pagePath(i + 1))
      )
      expect(await comparisons(store, interrupted.run.id)).toHaveLength(8)
    })

    it('cuts the pause between pages short when asked to stop', async () => {
      catalogue(6)
      const stopping = new AbortController()
      const control = { stopRequested: false, signal: stopping.signal }
      site.onPage = () => {
        setTimeout(() => {
          control.stopRequested = true
          stopping.abort()
        }, 50)
      }
      const patient = newCollection({ ...FAST, pageIntervalMs: 60_000 })

      const startedAt = Date.now()
      const { end } = await collect(store, control, patient)

      expect(end).toBe('requeued')
      expect(Date.now() - startedAt).toBeLessThan(5_000)
      expect(site.pageRequests).toHaveLength(1)
    })

    it('takes up again a run whose worker vanished, and gives up the third time', async () => {
      catalogue(6)
      const asked = await request()

      for (const attempt of [1, 2, 3]) {
        const claim = await runs.claimNext()

        expect(claim).toMatchObject({ runId: asked.id, attempt })

        // A live worker is left alone.
        expect(await runs.recoverAbandoned()).toBe(0)

        // The worker vanishes: no sign of life for ten minutes.
        await age(store, asked.id, 10)

        expect(await runs.recoverAbandoned()).toBe(1)
      }

      expect(await runs.get(store.id, asked.id)).toMatchObject({
        status: 'failed',
        errorCode: 'abandoned'
      })
      expect(await runs.claimNext()).toBeNull()
    })

    it('ignores a worker that comes back after its run was taken up by another', async () => {
      catalogue(6)
      const asked = await request()
      const stale = (await runs.claimNext()) as Claim
      await age(store, asked.id, 10)
      await runs.recoverAbandoned()
      const current = (await runs.claimNext()) as Claim

      expect([stale.attempt, current.attempt]).toEqual([1, 2])

      // The first worker wakes up and carries on as if nothing happened.
      expect(await runs.heartbeat(stale)).toBe(false)
      expect(await collection.execute(stale, steady())).toBe('lost')

      await runs.finish(stale, { status: 'failed', errorCode: 'internal_error' })
      await runs.requeue(stale)

      expect(await runs.get(store.id, asked.id)).toMatchObject({
        status: 'running',
        errorCode: null
      })
      expect(site.pageRequests).toEqual([])
      expect(await comparisons(store, asked.id)).toEqual([])

      // The worker that holds the run finishes it.
      expect(await runs.heartbeat(current)).toBe(true)
      expect(await collection.execute(current, steady())).toBe('finished')
      expect(await runs.get(store.id, asked.id)).toMatchObject({
        status: 'succeeded',
        itemsOk: 6
      })
    })

    it('records a crash as a failed run instead of leaving it running', async () => {
      catalogue(6)
      const broken = new CollectionService(
        prisma,
        runs,
        offersSync,
        settings,
        {
          fetchRobots: async () => {
            throw new Error('unexpected')
          }
        } as unknown as ProductPageClient,
        FAST
      )

      const { end, run } = await collect(store, steady(), broken)

      expect(end).toBe('finished')
      expect(run).toMatchObject({
        status: 'failed',
        errorCode: 'internal_error'
      })
    })
  })

  describe('one at a time', () => {
    it('gives the same run to whoever asks while one is waiting or running', async () => {
      const first = await runs.request(store.id, { trigger: 'schedule' }, TEST_ACTOR)
      const again = await runs.request(
        store.id,
        { trigger: 'manual', requestedBy: 'maria' },
        TEST_ACTOR
      )

      expect(first.created).toBe(true)
      expect(again).toMatchObject({ created: false, run: { id: first.run.id } })

      await runs.claimNext()
      const whileRunning = await runs.request(
        store.id,
        { trigger: 'manual', requestedBy: 'maria' },
        TEST_ACTOR
      )

      expect(whileRunning).toMatchObject({
        created: false,
        run: { id: first.run.id, status: 'running' }
      })
    })

    it('creates one run when many ask at the same instant', async () => {
      const answers = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          runs.request(
            store.id,
            { trigger: 'manual', requestedBy: `user-${i}` },
            TEST_ACTOR
          )
        )
      )

      expect(answers.filter((answer) => answer.created)).toHaveLength(1)
      expect(new Set(answers.map((answer) => answer.run.id)).size).toBe(1)
      expect(await runs.list(store.id, 50)).toHaveLength(1)
    })

    it('carries out one run at a time for the whole hub, oldest first', async () => {
      const second = await newStore('second')
      const third = await newStore('third')
      const a = await request(second)
      const b = await request(store)
      const c = await request(third)
      // Asked for at the same moment in this test; make the order certain.
      await age(second, a.id, 3)
      await age(store, b.id, 2)
      await age(third, c.id, 1)

      const first = await runs.claimNext()

      expect(first).toMatchObject({ storeId: second.id, runId: a.id })
      // Nothing else starts while that one is running.
      expect(await runs.claimNext()).toBeNull()

      await runs.finish(first as Claim, {
        status: 'failed',
        errorCode: 'internal_error'
      })

      expect(await runs.claimNext()).toMatchObject({ runId: b.id })
    })

    it('gives a waiting run to one worker when several reach for it', async () => {
      const asked = await request()

      const claims = await Promise.all(
        Array.from({ length: 6 }, () => runs.claimNext())
      )

      expect(claims.filter((claim) => claim !== null)).toEqual([
        { storeId: store.id, runId: asked.id, attempt: 1 }
      ])
    })
  })

  describe('asking again too soon', () => {
    const manual = (ignoreWait = false) =>
      runs.request(
        store.id,
        { trigger: 'manual', requestedBy: 'maria', ignoreWait },
        TEST_ACTOR
      )
    const waitOf = async () => {
      const error = await manual().catch((e: unknown) => e)
      return error instanceof RunTooSoonError ? error.retryAfterSeconds : null
    }

    it('makes a person wait a quarter of an hour after a good run', async () => {
      catalogue(6)
      const { run } = await collect()

      const wait = await waitOf()

      expect(wait).toBeGreaterThan(14 * 60)
      expect(wait).toBeLessThanOrEqual(15 * 60)
      expect(await runs.list(store.id, 50)).toHaveLength(1)

      await age(store, run.id, 16)

      expect((await manual()).created).toBe(true)
    })

    it('makes a person wait an hour after the website refused', async () => {
      catalogue(6)
      site.everyOtherPage(403)
      for (let n = 1; n <= 6; n++) site.pageStatus(products.base + n, 403)
      const { run } = await collect()

      expect(run.status).toBe('blocked')
      expect(await waitOf()).toBeGreaterThan(59 * 60)

      await age(store, run.id, 61)

      expect((await manual()).created).toBe(true)
    })

    it('lets a person try again a minute after a failure', async () => {
      server.acceptedKey = 'another-key-entirely'
      const { run } = await collect()

      expect(run.status).toBe('failed')
      expect(await waitOf()).toBeLessThanOrEqual(60)

      await age(store, run.id, 2)

      expect((await manual()).created).toBe(true)
    })

    it('does not make the schedule or an operator wait', async () => {
      catalogue(6)
      await collect()

      expect((await manual(true)).created).toBe(true)

      const claim = (await runs.claimNext()) as Claim
      await collection.execute(claim, steady())

      expect((await request()).status).toBe('queued')
    })

    it('records who asked', async () => {
      const { run } = await runs.request(
        store.id,
        { trigger: 'manual', requestedBy: `  ${'m'.repeat(200)}  ` },
        TEST_ACTOR
      )

      expect(run.requestedBy).toBe('m'.repeat(120))
      const events = await prisma.audit_events.findMany({
        where: { store_id: store.id, action: 'kk_run.requested' }
      })

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        target: run.id,
        actor_label: 'integration-test'
      })
    })
  })

  describe('the worker', () => {
    it('carries out the next waiting run, and rests when there is none', async () => {
      catalogue(6)
      const worker = new CollectionWorker(runs, collection)

      expect(await worker.tick()).toBe(false)

      const asked = await request()

      expect(await worker.tick()).toBe(true)
      expect(await runs.get(store.id, asked.id)).toMatchObject({
        status: 'succeeded',
        itemsOk: 6
      })
      expect(await worker.tick()).toBe(false)
    })

    it('puts its run back in the queue when the service is stopped', async () => {
      catalogue(8)
      const worker = new CollectionWorker(runs, collection)
      const asked = await request()
      let stopped: Promise<void> | undefined
      let read = 0
      site.onPage = () => {
        if (++read === 2) stopped = worker.onApplicationShutdown()
      }

      worker.start()
      while (!stopped) await new Promise((resolve) => setTimeout(resolve, 20))
      await stopped

      expect(await runs.get(store.id, asked.id)).toMatchObject({
        status: 'queued'
      })
      expect(site.pageRequests).toHaveLength(2)
    })
  })

  describe('the daily schedule', () => {
    const scheduler = () =>
      new CollectionScheduler(
        hub,
        runs,
        new KkCredentialService(credentials, fakeSellerApiClient(server))
      )
    const scheduled = async (of: TestStore) =>
      (await runs.list(of.id, 50)).filter((run) => run.trigger === 'schedule')

    it('asks for one run per store per day, from the set time on', async () => {
      catalogue(6)
      const keyless = await newStore('keyless', false)
      const clock = scheduler()

      // 06:30 in Lisbon, in winter, is 06:30 UTC.
      expect(await clock.tick('06:30', new Date('2030-01-15T06:29:00Z'))).toBe(0)
      expect(await scheduled(store)).toHaveLength(0)

      // Midnight has passed in Lisbon whenever this test runs.
      expect(await clock.tick('00:00')).toBe(1)
      expect(await scheduled(store)).toHaveLength(1)
      // A store without a key has nothing to collect.
      expect(await scheduled(keyless)).toHaveLength(0)

      // While it waits, and after it ran, today's run is not asked for again.
      expect(await clock.tick('00:00')).toBe(0)

      const claim = (await runs.claimNext()) as Claim
      await collection.execute(claim, steady())

      expect(await clock.tick('00:00')).toBe(0)
      expect(await scheduled(store)).toHaveLength(1)

      // The next day it is due again.
      const tomorrow = new Date(Date.now() + 24 * 60 * 60_000)

      expect(await clock.tick('00:00', tomorrow)).toBe(1)
      expect(await scheduled(store)).toHaveLength(2)
    })
  })
})
