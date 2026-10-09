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
import { uuidV7 } from '#/infra/ids/uuid-v7'
import type { TokenScope } from '#/modules/api-tokens/domain/token-principal'
import { ApiTokensService } from '#/modules/api-tokens/services/api-tokens.service'
import { KkStoreSettingsService } from '#/modules/kuantokusta/services/kk-store-settings.service'

import { createStore, deleteStores } from './support/database'
import type { TestStore } from './support/database'
import { ProductRange, TEST_ACTOR } from './support/kuantokusta'

const REPORT = '/v1/plugin/kuantokusta/report'
const EASY_ADJUST = '/v1/plugin/kuantokusta/settings/easy-adjust'
const history = (offerId: string) => `/v1/plugin/kuantokusta/offers/${offerId}/history`
const ALL: TokenScope[] = ['credentials:write', 'prices:read', 'prices:refresh']

const HOUR = 60 * 60_000
const DAY = 24 * HOUR

interface Compared {
  outcome: 'cheapest' | 'tied' | 'more_expensive' | 'only_store' | 'no_data'
  store: number
  lowest?: number
  totals?: [number, number]
}

// The report routes over HTTP, against a real database filled by hand: two
// collections, the second one blocked before it reached every offer.
describe('plugin API: price report', () => {
  const products = new ProductRange()
  let app: INestApplication
  let prisma: PrismaService
  let tokens: ApiTokensService
  let storeA: TestStore
  let storeB: TestStore
  let tokenA: string
  let tokenB: string
  let created: TestStore[] = []
  let productN = 0
  // Offer ids of store A, by the name used in the scenario.
  let offers: Record<string, string>
  let firstRun: string
  let secondRun: string

  const http = () => request(app.getHttpServer())
  const as = (token: string) => ({ Authorization: `Bearer ${token}` })
  const tokenFor = async (store: TestStore, scopes: TokenScope[]) =>
    (await tokens.issue({ storeId: store.id, label: 'test', scopes }, TEST_ACTOR))
      .token

  async function addOffer(
    store: TestStore,
    name: string,
    state: { stock?: number, delisted?: boolean } = {}
  ): Promise<string> {
    const n = ++productN
    const product = await prisma.kk_products.create({
      data: {
        external_id: products.base + n,
        url: `https://www.kuantokusta.pt/p/${products.base + n}/${name}`,
        name
      }
    })
    const offer = await prisma.withStore(store.id, (tx) =>
      tx.kk_store_offers.create({
        data: {
          store_id: store.id,
          product_id: product.id,
          kk_offer_ref: `p-9-${n}`,
          sku: `SKU-${n}`,
          ean: null,
          name,
          store_url: `https://zincomed.example/produto/${name}`,
          price_cents: 1000,
          stock: state.stock ?? 3,
          is_top_box: false,
          listing_status: state.delisted ? 'delisted' : 'listed'
        }
      })
    )
    return offer.id.toString()
  }

  async function addRun(
    store: TestStore,
    status: 'succeeded' | 'blocked' | 'running',
    finishedAt: Date
  ): Promise<string> {
    const id = uuidV7()
    const queuedAt = new Date(finishedAt.getTime() - HOUR)
    await prisma.withStore(store.id, (tx) =>
      tx.job_runs.create({
        data: {
          id,
          store_id: store.id,
          job_type: 'kk_full_collection',
          trigger: 'manual',
          requested_by: 'test',
          status,
          error_code: status === 'blocked' ? 'blocked_by_site' : null,
          queued_at: queuedAt,
          started_at: queuedAt,
          finished_at: status === 'running' ? null : finishedAt
        }
      })
    )
    return id
  }

  async function compare(
    store: TestStore,
    runId: string,
    offerId: string,
    at: Date,
    { outcome, store: storePrice, lowest, totals }: Compared
  ): Promise<void> {
    const hasLowest = lowest !== undefined
    await prisma.withStore(store.id, (tx) =>
      tx.kk_price_comparisons.create({
        data: {
          store_id: store.id,
          run_id: runId,
          store_offer_id: BigInt(offerId),
          outcome,
          store_price_cents: storePrice,
          store_is_listed: outcome === 'no_data' ? null : true,
          lowest_price_cents: lowest ?? null,
          lowest_store_name: hasLowest ? 'Farmácia B' : null,
          lowest_store_slug: hasLowest ? 'farmacia-b' : null,
          difference_cents: hasLowest ? storePrice - lowest : null,
          store_position: outcome === 'no_data' ? null : hasLowest && storePrice > lowest ? 2 : 1,
          store_count: outcome === 'no_data' ? null : hasLowest ? 2 : 1,
          store_total_cents: totals?.[0] ?? null,
          lowest_total_cents: totals?.[1] ?? null,
          lowest_total_store_name: totals ? 'Farmácia B' : null,
          compared_at: at
        }
      })
    )
  }

  const ids = (body: { rows: { offerId: string }[] }) =>
    body.rows.map((row) => row.offerId)

  beforeAll(async () => {
    Logger.overrideLogger(false)
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    prisma = app.get(PrismaService)
    tokens = app.get(ApiTokensService)
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(async () => {
    storeA = await createStore(prisma, 'report-a')
    storeB = await createStore(prisma, 'report-b')
    created.push(storeA, storeB)
    tokenA = await tokenFor(storeA, ALL)
    tokenB = await tokenFor(storeB, ALL)
    // Store B has no settings yet: its first collection never ran.
    await prisma.withStore(storeA.id, (tx) =>
      tx.kk_store_settings.create({
        data: { store_id: storeA.id, store_slug: storeA.slug }
      })
    )

    offers = {
      easy: await addOffer(storeA, 'easy'),
      dearer: await addOffer(storeA, 'dearer'),
      wrongPage: await addOffer(storeA, 'wrong-page'),
      unread: await addOffer(storeA, 'unread'),
      notReached: await addOffer(storeA, 'not-reached'),
      outOfStock: await addOffer(storeA, 'out-of-stock', { stock: 0 }),
      delisted: await addOffer(storeA, 'delisted', { delisted: true }),
      neverCompared: await addOffer(storeA, 'never-compared')
    }

    const now = Date.now()
    const first = new Date(now - DAY)
    const second = new Date(now - HOUR)
    firstRun = await addRun(storeA, 'succeeded', first)
    secondRun = await addRun(storeA, 'blocked', second)

    // The first collection reached every offer that was active then.
    for (const name of ['easy', 'dearer', 'wrongPage', 'unread', 'notReached', 'outOfStock', 'delisted']) {
      await compare(storeA, firstRun, offers[name], first, {
        outcome: 'tied',
        store: 1000,
        lowest: 1000
      })
    }
    // The second was blocked before it reached `notReached`.
    await compare(storeA, secondRun, offers.easy, second, {
      outcome: 'more_expensive',
      store: 1005,
      lowest: 1000,
      totals: [1504, 1199]
    })
    await compare(storeA, secondRun, offers.dearer, second, {
      outcome: 'more_expensive',
      store: 1000,
      lowest: 700
    })
    // A box of 10 against a single unit: a different product.
    await compare(storeA, secondRun, offers.wrongPage, second, {
      outcome: 'cheapest',
      store: 175,
      lowest: 2789
    })
    await compare(storeA, secondRun, offers.unread, second, {
      outcome: 'no_data',
      store: 1000
    })

    const offerB = await addOffer(storeB, 'b-only')
    const runB = await addRun(storeB, 'succeeded', second)
    await compare(storeB, runB, offerB, second, {
      outcome: 'only_store',
      store: 1234
    })
  })

  afterEach(async () => {
    await deleteStores(prisma, created)
    created = []
    await products.cleanUp(prisma)
  })

  it('lists the latest comparison of each active offer, with the derived fields', async () => {
    const response = await http().get(REPORT).set(as(tokenA))

    expect(response.status).toBe(200)
    expect(response.body.run).toMatchObject({
      id: secondRun,
      status: 'blocked',
      errorCode: 'blocked_by_site'
    })
    expect(response.body.easyAdjustCents).toBe(10)
    expect(response.body.checkLinkPercent).toBe(50)
    expect(response.body.nextCursor).toBeNull()
    // Out of stock, delisted and never compared are left out by default.
    expect(ids(response.body)).toEqual([
      offers.easy,
      offers.dearer,
      offers.wrongPage,
      offers.unread,
      offers.notReached
    ])

    const [easy, dearer, wrongPage, unread, notReached] = response.body.rows
    expect(easy).toEqual({
      offerId: offers.easy,
      offerRef: expect.stringMatching(/^p-9-\d+$/),
      sku: expect.stringMatching(/^SKU-\d+$/),
      ean: null,
      name: 'easy',
      storeUrl: 'https://zincomed.example/produto/easy',
      productUrl: expect.stringMatching(/^https:\/\/www\.kuantokusta\.pt\/p\/\d+\/easy$/),
      offerState: 'active',
      runId: secondRun,
      comparedAt: expect.any(String),
      stale: false,
      outcome: 'more_expensive',
      storePriceCents: 1005,
      storeIsListed: true,
      lowestPriceCents: 1000,
      lowestStoreName: 'Farmácia B',
      differenceCents: 5,
      differencePercent: expect.closeTo(0.4975, 4),
      easyAdjust: true,
      checkLink: false,
      storePosition: 2,
      storeCount: 2,
      storeTotalCents: 1504,
      lowestTotalCents: 1199,
      lowestTotalStoreName: 'Farmácia B',
      totalDifferenceCents: 305
    })
    expect(dearer).toMatchObject({ differenceCents: 300, easyAdjust: false, checkLink: false })
    expect(dearer.differencePercent).toBeCloseTo(30, 6)
    expect(wrongPage).toMatchObject({
      outcome: 'cheapest',
      differenceCents: -2614,
      easyAdjust: false,
      checkLink: true
    })
    expect(unread).toMatchObject({
      outcome: 'no_data',
      lowestPriceCents: null,
      differencePercent: null,
      easyAdjust: false,
      checkLink: false,
      stale: false
    })
    // Not reached by the blocked collection: the previous comparison stays.
    expect(notReached).toMatchObject({ runId: firstRun, outcome: 'tied', stale: true })

    expect(response.body.summary).toEqual({
      offers: 5,
      cheapest: 1,
      tied: 1,
      more_expensive: 2,
      only_store: 0,
      no_data: 1,
      easyAdjust: 1,
      checkLink: 1,
      stale: 1
    })
  })

  it('filters by outcome, easy adjust and the link check, keeping the summary whole', async () => {
    const get = async (query: string) => {
      const response = await http().get(`${REPORT}?${query}`).set(as(tokenA))
      expect(response.status).toBe(200)
      expect(response.body.summary.offers).toBe(5)
      return ids(response.body)
    }

    expect(await get('outcome=more_expensive')).toEqual([offers.easy, offers.dearer])
    expect(await get('easyAdjust=true')).toEqual([offers.easy])
    expect(await get('easyAdjust=false')).toEqual([
      offers.dearer,
      offers.wrongPage,
      offers.unread,
      offers.notReached
    ])
    expect(await get('checkLink=true')).toEqual([offers.wrongPage])
    expect(await get('checkLink=false&outcome=no_data')).toEqual([offers.unread])
  })

  it('shows offers that left the stock or KuantoKusta only when asked', async () => {
    const all = await http().get(`${REPORT}?state=all`).set(as(tokenA))
    expect(all.body.summary.offers).toBe(7)
    expect(
      Object.fromEntries(
        all.body.rows.map((row: { offerId: string, offerState: string }) => [
          row.offerId,
          row.offerState
        ])
      )
    ).toMatchObject({
      [offers.outOfStock]: 'out_of_stock',
      [offers.delisted]: 'delisted',
      [offers.easy]: 'active'
    })
    expect(ids(all.body)).not.toContain(offers.neverCompared)

    const outOfStock = await http().get(`${REPORT}?state=out_of_stock`).set(as(tokenA))
    expect(ids(outOfStock.body)).toEqual([offers.outOfStock])
    expect(outOfStock.body.rows[0].stale).toBe(true)

    const delisted = await http().get(`${REPORT}?state=delisted`).set(as(tokenA))
    expect(ids(delisted.body)).toEqual([offers.delisted])
  })

  it('pages through the report with the cursor', async () => {
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const query: string = cursor ? `limit=2&after=${cursor}` : 'limit=2'
      const response = await http().get(`${REPORT}?${query}`).set(as(tokenA))
      expect(response.status).toBe(200)
      expect(response.body.rows.length).toBeLessThanOrEqual(2)
      seen.push(...ids(response.body))
      cursor = response.body.nextCursor
      pages++
    } while (cursor && pages < 10)

    expect(pages).toBe(3)
    expect(seen).toEqual([
      offers.easy,
      offers.dearer,
      offers.wrongPage,
      offers.unread,
      offers.notReached
    ])
  })

  it('rejects malformed queries', async () => {
    for (const query of [
      'limit=0',
      'limit=201',
      'after=abc',
      'state=gone',
      'outcome=cheaper',
      'easyAdjust=maybe',
      'store=other'
    ]) {
      const response = await http().get(`${REPORT}?${query}`).set(as(tokenA))
      expect([query, response.status]).toEqual([query, 400])
    }
  })

  it('does not count comparisons of a newer collection still running as stale', async () => {
    // Comparisons are written when a collection ends. Even if one shows up
    // early, the reference is the most recent collection that ended.
    const running = await addRun(storeA, 'running', new Date())
    await compare(storeA, running, offers.notReached, new Date(), {
      outcome: 'cheapest',
      store: 900,
      lowest: 1000
    })

    const response = await http().get(REPORT).set(as(tokenA))
    expect(response.body.run.id).toBe(secondRun)
    const row = response.body.rows.find(
      (candidate: { offerId: string }) => candidate.offerId === offers.notReached
    )
    expect(row).toMatchObject({ runId: running, stale: false })
    expect(response.body.summary.stale).toBe(0)
  })

  it('keeps each store to its own report', async () => {
    const response = await http().get(REPORT).set(as(tokenB))

    expect(response.status).toBe(200)
    expect(response.body.rows).toHaveLength(1)
    expect(response.body.rows[0]).toMatchObject({ name: 'b-only', outcome: 'only_store' })
    expect(response.body.summary.offers).toBe(1)
    // B never had its settings created: the default threshold applies.
    expect(response.body.easyAdjustCents).toBe(10)
  })

  it('answers with an empty report for a store that never had a collection', async () => {
    const storeC = await createStore(prisma, 'report-c')
    created.push(storeC)
    const tokenC = await tokenFor(storeC, ['prices:read'])

    const response = await http().get(REPORT).set(as(tokenC))
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ run: null, rows: [], nextCursor: null })
    expect(response.body.summary.offers).toBe(0)
  })

  it('needs prices:read', async () => {
    const writeOnly = await tokenFor(storeA, ['credentials:write'])
    expect((await http().get(REPORT).set(as(writeOnly))).status).toBe(403)
    expect((await http().get(history(offers.easy)).set(as(writeOnly))).status).toBe(403)
    expect((await http().get(EASY_ADJUST).set(as(writeOnly))).status).toBe(403)
    expect((await http().get(REPORT)).status).toBe(401)
  })

  describe('easy-adjust threshold', () => {
    it('reads and changes it, and the report follows at once', async () => {
      expect((await http().get(EASY_ADJUST).set(as(tokenA))).body).toEqual({ cents: 10 })

      const changed = await http().put(EASY_ADJUST).set(as(tokenA)).send({ cents: 300 })
      expect(changed.status).toBe(200)
      expect(changed.body).toEqual({ cents: 300 })
      expect((await http().get(EASY_ADJUST).set(as(tokenA))).body).toEqual({ cents: 300 })

      const report = await http().get(`${REPORT}?easyAdjust=true`).set(as(tokenA))
      expect(report.body.easyAdjustCents).toBe(300)
      expect(ids(report.body)).toEqual([offers.easy, offers.dearer])

      const events = await prisma.audit_events.findMany({
        where: { store_id: storeA.id, action: 'kk_settings.easy_adjust_changed' }
      })
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        actor_type: 'api_token',
        details: { fromCents: 10, toCents: 300 }
      })
    })

    it('records nothing when the value does not change', async () => {
      await http().put(EASY_ADJUST).set(as(tokenA)).send({ cents: 10 }).expect(200)
      const events = await prisma.audit_events.count({
        where: { store_id: storeA.id, action: 'kk_settings.easy_adjust_changed' }
      })
      expect(events).toBe(0)
    })

    it('needs prices:refresh to change it', async () => {
      const readOnly = await tokenFor(storeA, ['prices:read'])
      const response = await http().put(EASY_ADJUST).set(as(readOnly)).send({ cents: 20 })
      expect(response.status).toBe(403)
      expect(response.body.error.code).toBe('insufficient_scope')
    })

    it('refuses a value that is not a whole number of cents in range', async () => {
      for (const body of [{ cents: -1 }, { cents: 1.5 }, { cents: 100_001 }, { cents: '10' }, {}, { cents: 10, storeId: storeB.id }]) {
        const response = await http().put(EASY_ADJUST).set(as(tokenA)).send(body)
        expect([body, response.status]).toEqual([body, 400])
      }
    })

    it('can be changed before the store\'s first collection', async () => {
      // Store B never had a collection, so the hub does not know yet how it
      // appears on KuantoKusta.
      expect((await http().get(EASY_ADJUST).set(as(tokenB))).body).toEqual({ cents: 10 })

      const response = await http().put(EASY_ADJUST).set(as(tokenB)).send({ cents: 20 })

      expect(response.status).toBe(200)
      expect(response.body).toEqual({ cents: 20 })
      expect((await http().get(EASY_ADJUST).set(as(tokenB))).body).toEqual({ cents: 20 })
      // Only the threshold was stored: the identity is still to be found.
      expect(await app.get(KkStoreSettingsService).get(storeB.id)).toEqual({
        identity: null,
        easyAdjustCents: 20
      })
      // And store A's threshold did not move.
      expect((await http().get(EASY_ADJUST).set(as(tokenA))).body).not.toEqual({ cents: 20 })
    })

    it('keeps a threshold set early when the identity is found later', async () => {
      const settings = app.get(KkStoreSettingsService)
      await http().put(EASY_ADJUST).set(as(tokenB)).send({ cents: 35 })

      await settings.setIdentity(storeB.id, { storeSlug: 'loja-b-early', sellerId: 987_001 })

      expect(await settings.get(storeB.id)).toEqual({
        identity: { storeSlug: 'loja-b-early', sellerId: 987_001 },
        easyAdjustCents: 35
      })
    })
  })

  describe('price history', () => {
    it('lists every comparison of an offer, newest first, in pages', async () => {
      const response = await http().get(history(offers.easy)).set(as(tokenA))
      expect(response.status).toBe(200)
      expect(response.body.nextCursor).toBeNull()
      expect(response.body.entries).toEqual([
        {
          id: expect.any(String),
          runId: secondRun,
          comparedAt: expect.any(String),
          outcome: 'more_expensive',
          storePriceCents: 1005,
          lowestPriceCents: 1000,
          lowestStoreName: 'Farmácia B',
          differenceCents: 5,
          differencePercent: expect.closeTo(0.4975, 4),
          storePosition: 2,
          storeCount: 2,
          storeTotalCents: 1504,
          lowestTotalCents: 1199
        },
        expect.objectContaining({ runId: firstRun, outcome: 'tied' })
      ])

      const first = await http().get(`${history(offers.easy)}?limit=1`).set(as(tokenA))
      expect(first.body.entries.map((entry: { runId: string }) => entry.runId)).toEqual([secondRun])
      const second = await http()
        .get(`${history(offers.easy)}?limit=1&before=${first.body.nextCursor}`)
        .set(as(tokenA))
      expect(second.body.entries.map((entry: { runId: string }) => entry.runId)).toEqual([firstRun])
      expect(second.body.nextCursor).toBeNull()
    })

    it('does not show another store\'s offer', async () => {
      const response = await http().get(history(offers.easy)).set(as(tokenB))
      expect(response.status).toBe(404)
      expect(response.body.error.code).toBe('kk_offer_not_found')
      expect((await http().get(history('999999999999')).set(as(tokenA))).status).toBe(404)
      expect((await http().get(history('abc')).set(as(tokenA))).status).toBe(400)
    })
  })
})
