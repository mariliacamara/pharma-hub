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
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { AppModule } from '#/app.module'
import { PrismaService } from '#/infra/database/prisma.service'
import type { TokenScope } from '#/modules/api-tokens/domain/token-principal'
import { ApiTokensService } from '#/modules/api-tokens/services/api-tokens.service'
import { AuditService } from '#/modules/audit/services/audit.service'
import { CredentialsService } from '#/modules/credentials/services/credentials.service'
import { CollectionRunsService } from '#/modules/kuantokusta/services/collection-runs.service'
import { CollectionService } from '#/modules/kuantokusta/services/collection.service'
import { CollectionWorker } from '#/modules/kuantokusta/services/collection.worker'
import { KkStoreSettingsService } from '#/modules/kuantokusta/services/kk-store-settings.service'
import { OffersSyncService } from '#/modules/kuantokusta/services/offers-sync.service'
import { ProductPageClient } from '#/modules/kuantokusta/services/product-page.client'
import { KkSellerApiClient } from '#/modules/kuantokusta/services/seller-api.client'

import { FakeKkServer } from '../support/fake-kk-server'
import { FakeKkSite } from '../support/fake-kk-site'
import { createStore, deleteStores, onlyStores } from './support/database'
import type { TestStore } from './support/database'
import {
  fakeSellerApiClient,
  ProductRange,
  TEST_ACTOR
} from './support/kuantokusta'

const RUNS = '/v1/plugin/kuantokusta/runs'
const ALL: TokenScope[] = ['credentials:write', 'prices:read', 'prices:refresh']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// The collection routes over HTTP, with the whole application, a real
// database, a fake Seller API and a fake KuantoKusta website.
describe('plugin API: collections', () => {
  const server = new FakeKkServer()
  const site = new FakeKkSite()
  const products = new ProductRange()
  let app: INestApplication
  let prisma: PrismaService
  let tokens: ApiTokensService
  let worker: CollectionWorker
  let storeA: TestStore
  let storeB: TestStore
  let tokenA: string
  let tokenB: string
  let created: TestStore[] = []

  const http = () => request(app.getHttpServer())
  const as = (token: string) => ({ Authorization: `Bearer ${token}` })
  const tokenFor = async (store: TestStore, scopes: TokenScope[]) =>
    (await tokens.issue({ storeId: store.id, label: 'test', scopes }, TEST_ACTOR))
      .token
  const setKey = (store: TestStore) =>
    app.get(CredentialsService).set(
      { storeId: store.id, provider: 'kuantokusta', secret: server.acceptedKey },
      TEST_ACTOR
    )

  beforeAll(async () => {
    Logger.overrideLogger(false)
    await server.start()
    await site.start()

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(KkSellerApiClient)
      .useValue(fakeSellerApiClient(server))
      .overrideProvider(ProductPageClient)
      .useFactory({
        factory: () =>
          new ProductPageClient({
            baseUrl: site.url,
            userAgent: 'PharmaHubPriceReport/1.0 (integration test)'
          })
      })
      // The queue sees only this file's stores (see onlyStores).
      .overrideProvider(CollectionRunsService)
      .useFactory({
        factory: (db: PrismaService, audit: AuditService) =>
          new CollectionRunsService(onlyStores(db, () => created), audit),
        inject: [PrismaService, AuditService]
      })
      // No pause between pages.
      .overrideProvider(CollectionService)
      .useFactory({
        factory: (
          db: PrismaService,
          runs: CollectionRunsService,
          offersSync: OffersSyncService,
          settings: KkStoreSettingsService,
          pages: ProductPageClient
        ) =>
          new CollectionService(db, runs, offersSync, settings, pages, {
            pageIntervalMs: 0,
            reuseReadingsForMs: 2 * 60 * 60_000,
            blockCooldownMs: 30 * 60_000,
            maxRunMs: 60 * 60_000
          }),
        inject: [
          PrismaService,
          CollectionRunsService,
          OffersSyncService,
          KkStoreSettingsService,
          ProductPageClient
        ]
      })
      .compile()
    app = moduleRef.createNestApplication()
    await app.init()

    prisma = app.get(PrismaService)
    tokens = app.get(ApiTokensService)
    worker = app.get(CollectionWorker)
  })

  afterAll(async () => {
    await app.close()
    await server.stop()
    await site.stop()
  })

  beforeEach(async () => {
    server.reset()
    site.reset()
    storeA = await createStore(prisma, 'runs-a')
    storeB = await createStore(prisma, 'runs-b')
    created.push(storeA, storeB)
    tokenA = await tokenFor(storeA, ALL)
    tokenB = await tokenFor(storeB, ALL)
    await setKey(storeA)

    // Six offers; on each page the store has its price and a rival is
    // cheaper on the first two.
    server.offers = Array.from({ length: 6 }, (_, i) =>
      products.offer(i + 1, { price: 10 + i })
    )
    for (let n = 1; n <= 6; n++) {
      site.page(products.base + n, [
        { storeName: 'Zincomed', storeSlug: 'zincomed', sellerId: 77, price: 9 + n },
        {
          storeName: 'Farmácia B',
          storeSlug: 'farmacia-b',
          sellerId: 5,
          price: n <= 2 ? 8 + n : 20 + n
        }
      ])
    }
  })

  afterEach(async () => {
    await deleteStores(prisma, created)
    created = []
    await products.cleanUp(prisma)
  })

  it('does not start the worker by itself', async () => {
    await http().post(RUNS).set(as(tokenA)).send({})
    await new Promise((resolve) => setTimeout(resolve, 300))

    const latest = await http().get(`${RUNS}/latest`).set(as(tokenA))

    // Only main.ts starts it; here the run stays where it was put.
    expect(latest.body.run.status).toBe('queued')
    expect(site.requests).toEqual([])
  })

  it('asks for a collection, follows it and reads how it ended', async () => {
    const asked = await http()
      .post(RUNS)
      .set(as(tokenA))
      .send({ requestedBy: 'maria.silva' })

    expect(asked.status).toBe(202)
    expect(asked.body).toEqual({
      created: true,
      run: {
        id: expect.stringMatching(UUID),
        status: 'queued',
        trigger: 'manual',
        requestedBy: 'maria.silva',
        progress: { total: 0, read: 0, notRead: 0 },
        errorCode: null,
        queuedAt: expect.any(String),
        startedAt: null,
        finishedAt: null
      }
    })
    const { id } = asked.body.run

    // Asking again while it waits returns the same one.
    const again = await http().post(RUNS).set(as(tokenA)).send({})

    expect(again.status).toBe(202)
    expect(again.body).toMatchObject({ created: false, run: { id } })

    const waiting = await http().get(`${RUNS}/${id}`).set(as(tokenA))

    expect(waiting.status).toBe(200)
    expect(waiting.body).toMatchObject({
      run: { id, status: 'queued' },
      summary: { cheapest: 0, tied: 0, more_expensive: 0, only_store: 0, no_data: 0 }
    })

    expect(await worker.tick()).toBe(true)

    const done = await http().get(`${RUNS}/${id}`).set(as(tokenA))

    expect(done.body).toEqual({
      run: {
        id,
        status: 'succeeded',
        trigger: 'manual',
        requestedBy: 'maria.silva',
        progress: { total: 6, read: 6, notRead: 0 },
        errorCode: null,
        queuedAt: expect.any(String),
        startedAt: expect.any(String),
        finishedAt: expect.any(String)
      },
      summary: {
        cheapest: 4,
        tied: 0,
        more_expensive: 2,
        only_store: 0,
        no_data: 0
      }
    })

    const latest = await http().get(`${RUNS}/latest`).set(as(tokenA))

    expect(latest.body).toEqual(done.body)

    const list = await http().get(RUNS).set(as(tokenA))

    expect(list.body.runs).toEqual([done.body.run])
  })

  it('names the token when the plugin does not say who asked', async () => {
    const withoutBody = await http().post(RUNS).set(as(tokenA))

    expect(withoutBody.status).toBe(202)
    expect(withoutBody.body.run.requestedBy).toBe(`token ${tokenA.slice(4, 12)}`)
  })

  it('refuses a new collection right after one, and says how long to wait', async () => {
    await http().post(RUNS).set(as(tokenA)).send({})
    await worker.tick()

    const tooSoon = await http().post(RUNS).set(as(tokenA)).send({})

    expect(tooSoon.status).toBe(429)
    expect(tooSoon.body.error.code).toBe('kk_run_too_soon')
    expect(Number(tooSoon.headers['retry-after'])).toBeGreaterThan(14 * 60)
    expect(Number(tooSoon.headers['retry-after'])).toBeLessThanOrEqual(15 * 60)
    expect((await http().get(RUNS).set(as(tokenA))).body.runs).toHaveLength(1)
  })

  it('refuses to queue anything for a store without a key', async () => {
    const response = await http().post(RUNS).set(as(tokenB)).send({})

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('kk_key_missing')
    expect((await http().get(RUNS).set(as(tokenB))).body.runs).toEqual([])
  })

  it('reports why a collection failed or was blocked', async () => {
    for (let n = 1; n <= 6; n++) site.pageStatus(products.base + n, 403)
    await http().post(RUNS).set(as(tokenA)).send({})
    await worker.tick()

    const latest = await http().get(`${RUNS}/latest`).set(as(tokenA))

    expect(latest.body.run).toMatchObject({
      status: 'blocked',
      errorCode: 'blocked_by_site',
      progress: { total: 6, read: 0, notRead: 3 }
    })
  })

  it('answers "none yet" before the first collection', async () => {
    const latest = await http().get(`${RUNS}/latest`).set(as(tokenA))

    expect(latest.status).toBe(200)
    expect(latest.body).toEqual({ run: null, summary: null })
    expect((await http().get(RUNS).set(as(tokenA))).body).toEqual({ runs: [] })
  })

  it('never shows one store the collections of another', async () => {
    const asked = await http().post(RUNS).set(as(tokenA)).send({})
    await worker.tick()
    const { id } = asked.body.run

    const direct = await http().get(`${RUNS}/${id}`).set(as(tokenB))

    expect(direct.status).toBe(404)
    expect(direct.body.error.code).toBe('kk_run_not_found')
    expect((await http().get(`${RUNS}/latest`).set(as(tokenB))).body).toEqual({
      run: null,
      summary: null
    })
    expect((await http().get(RUNS).set(as(tokenB))).body).toEqual({ runs: [] })

    // And a collection of the other store is its own, not a view of this one.
    await setKey(storeB)
    const own = await http().post(RUNS).set(as(tokenB)).send({})

    expect(own.body).toMatchObject({ created: true })
    expect(own.body.run.id).not.toBe(id)
  })

  it('asks for the scope of each route', async () => {
    const reader = await tokenFor(storeA, ['prices:read'])
    const refresher = await tokenFor(storeA, ['prices:refresh'])
    const keyOnly = await tokenFor(storeA, ['credentials:write'])

    expect((await http().post(RUNS).set(as(reader)).send({})).status).toBe(403)
    expect((await http().post(RUNS).set(as(keyOnly)).send({})).status).toBe(403)
    expect((await http().get(RUNS).set(as(refresher))).status).toBe(403)
    expect((await http().get(`${RUNS}/latest`).set(as(refresher))).status)
      .toBe(403)
    expect((await http().get(RUNS).set(as(reader))).body).toEqual({ runs: [] })

    const asked = await http().post(RUNS).set(as(refresher)).send({})

    expect(asked.status).toBe(202)
    expect(
      (await http().get(`${RUNS}/${asked.body.run.id}`).set(as(refresher))).status
    ).toBe(403)
    expect(
      (await http().get(`${RUNS}/${asked.body.run.id}`).set(as(reader))).status
    ).toBe(200)
  })

  it.each([
    ['an unknown field', { storeId: 'another-store' }],
    ['a store chosen by the caller', { requestedBy: 'x', store: 'zincomed' }],
    ['an empty name', { requestedBy: '   ' }],
    ['a name that is too long', { requestedBy: 'x'.repeat(121) }],
    ['a name that is not text', { requestedBy: 42 }],
    ['a name with control characters', { requestedBy: 'maria\u001b[31m' }],
    ['a name with a line break', { requestedBy: 'maria\nsilva' }]
  ])('refuses a request with %s', async (_case, body) => {
    const response = await http().post(RUNS).set(as(tokenA)).send(body)

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('invalid_request')
    expect((await http().get(RUNS).set(as(tokenA))).body.runs).toEqual([])
  })

  it.each([
    'not-a-uuid',
    '1',
    '019fc5d3-5c00-7000-8000-00000000000g',
    '019fc5d3-5c00-7000-8000-000000000001\'; DROP TABLE job_runs; --'
  ])('refuses the id %s', async (id) => {
    const response = await http()
      .get(`${RUNS}/${encodeURIComponent(id)}`)
      .set(as(tokenA))

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('invalid_request')
  })

  it('answers 404 for an id that does not exist', async () => {
    const response = await http()
      .get(`${RUNS}/019fc5d3-5c00-7000-8000-000000000001`)
      .set(as(tokenA))

    expect(response.status).toBe(404)
  })

  it.each([['limit=0'], ['limit=51'], ['limit=abc'], ['status=running']])(
    'refuses the list with %s',
    async (query) => {
      const response = await http().get(`${RUNS}?${query}`).set(as(tokenA))

      expect(response.status).toBe(400)
    }
  )
})
