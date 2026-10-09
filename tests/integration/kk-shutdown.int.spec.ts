import { describe, beforeAll, afterAll, it, expect } from '@jest/globals'
import { Logger } from '@nestjs/common'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { AppModule } from '#/app.module'
import { PrismaService } from '#/infra/database/prisma.service'
import { AuditService } from '#/modules/audit/services/audit.service'
import { CredentialsService } from '#/modules/credentials/services/credentials.service'
import { CollectionRunsService } from '#/modules/kuantokusta/services/collection-runs.service'
import { CollectionWorker } from '#/modules/kuantokusta/services/collection.worker'
import { ProductPageClient } from '#/modules/kuantokusta/services/product-page.client'
import { KkSellerApiClient } from '#/modules/kuantokusta/services/seller-api.client'

import { FakeKkServer } from '../support/fake-kk-server'
import { FakeKkSite } from '../support/fake-kk-site'
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
  TEST_ACTOR
} from './support/kuantokusta'

// What happens to a collection when the whole service is stopped, as on a
// redeploy: the real application, closed the way the host closes it.
describe('stopping the service during a collection', () => {
  const server = new FakeKkServer()
  const site = new FakeKkSite()
  const products = new ProductRange()
  // A connection of the test's own, to look at the database after the
  // application has closed its pool.
  let observer: PrismaService
  let app: INestApplication
  let store: TestStore
  const created: TestStore[] = []

  beforeAll(async () => {
    Logger.overrideLogger(false)
    await server.start()
    await site.start()
    observer = appPrisma()
    await observer.onModuleInit()

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
      .overrideProvider(CollectionRunsService)
      .useFactory({
        factory: (db: PrismaService, audit: AuditService) =>
          new CollectionRunsService(onlyStores(db, () => created), audit),
        inject: [PrismaService, AuditService]
      })
      .compile()
    app = moduleRef.createNestApplication()
    await app.init()

    store = await createStore(observer, 'shutdown')
    created.push(store)
    await app.get(CredentialsService).set(
      { storeId: store.id, provider: 'kuantokusta', secret: server.acceptedKey },
      TEST_ACTOR
    )
    server.offers = Array.from({ length: 8 }, (_, i) =>
      products.offer(i + 1, { price: 10 + i })
    )
    for (let n = 1; n <= 8; n++) {
      site.page(products.base + n, [
        { storeName: 'Zincomed', storeSlug: 'zincomed', price: 9 + n }
      ])
    }
  })

  afterAll(async () => {
    await deleteStores(observer, created)
    await products.cleanUp(observer)
    await observer.onApplicationShutdown()
    await server.stop()
    await site.stop()
  })

  it('puts the run back in the queue before the database is closed', async () => {
    const runs = app.get(CollectionRunsService)
    const { run } = await runs.request(
      store.id,
      { trigger: 'schedule' },
      TEST_ACTOR
    )

    // The service is stopped while the worker waits between the first page
    // and the second (five seconds, the real pause).
    let closed: Promise<void> | undefined
    site.onPage = () => {
      closed ??= app.close()
    }
    app.get(CollectionWorker).start()
    while (!closed) await new Promise((resolve) => setTimeout(resolve, 20))
    const startedAt = Date.now()
    await closed

    // It did not wait out the pause, and it did not leave the run behind.
    expect(Date.now() - startedAt).toBeLessThan(4_000)
    const after = await observer.withStore(store.id, (tx) =>
      tx.job_runs.findUniqueOrThrow({ where: { id: run.id } })
    )

    expect(after).toMatchObject({
      status: 'queued',
      started_at: null,
      attempts: 0,
      error_code: null
    })
    expect(site.pageRequests).toHaveLength(1)
    // The page it had read is kept for when the run is taken up again.
    const kept = await observer.kk_page_snapshots.count({
      where: { kk_products: { external_id: products.base + 1 } }
    })

    expect(kept).toBe(1)
  })
})
