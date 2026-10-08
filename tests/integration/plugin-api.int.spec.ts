import {
  describe,
  beforeAll,
  beforeEach,
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
import { generateToken } from '#/modules/api-tokens/domain/token'
import type { TokenScope } from '#/modules/api-tokens/domain/token-principal'
import { ApiTokensService } from '#/modules/api-tokens/services/api-tokens.service'
import { OffersSyncService } from '#/modules/kuantokusta/services/offers-sync.service'
import { KkSellerApiClient } from '#/modules/kuantokusta/services/seller-api.client'

import { FakeKkServer } from '../support/fake-kk-server'
import { createStore, deleteStores } from './support/database'
import type { TestStore } from './support/database'
import {
  fakeSellerApiClient,
  ProductRange,
  TEST_ACTOR
} from './support/kuantokusta'

const CREDENTIAL = '/v1/plugin/kuantokusta/credential'
const OFFERS = '/v1/plugin/kuantokusta/offers'
const ALL: TokenScope[] = ['credentials:write', 'prices:read', 'prices:refresh']

// The whole application over HTTP, with a real database and a fake
// KuantoKusta.
describe('plugin API', () => {
  const server = new FakeKkServer()
  const products = new ProductRange()
  let app: INestApplication
  let prisma: PrismaService
  let tokens: ApiTokensService
  let storeA: TestStore
  let storeB: TestStore
  let tokenA: string
  let tokenB: string
  const created: TestStore[] = []

  const http = () => request(app.getHttpServer())
  const as = (token: string) => ({ Authorization: `Bearer ${token}` })
  const tokenFor = async (store: TestStore, scopes: TokenScope[]) =>
    (await tokens.issue({ storeId: store.id, label: 'test', scopes }, TEST_ACTOR))
      .token

  beforeAll(async () => {
    Logger.overrideLogger(false)
    await server.start()

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(KkSellerApiClient)
      .useValue(fakeSellerApiClient(server))
      .compile()
    app = moduleRef.createNestApplication()
    await app.init()

    prisma = app.get(PrismaService)
    tokens = app.get(ApiTokensService)
  })

  afterAll(async () => {
    await deleteStores(prisma, created)
    await products.cleanUp(prisma)
    await app.close()
    await server.stop()
  })

  beforeEach(async () => {
    server.reset()
    storeA = await createStore(prisma, 'api-a')
    storeB = await createStore(prisma, 'api-b')
    created.push(storeA, storeB)
    tokenA = await tokenFor(storeA, ALL)
    tokenB = await tokenFor(storeB, ALL)
  })

  describe('authentication', () => {
    it('refuses every route without a token, except the health checks', async () => {
      // Read from the running application, so a route added later is covered
      // without anyone remembering to list it here.
      const all = registeredRoutes(app)
      const open = all.filter((route) => route.path.startsWith('/health/'))
      const routes = all.filter((route) => !open.includes(route))

      expect(open.map((route) => route.path).sort()).toEqual([
        '/health/live',
        '/health/ready'
      ])
      expect(routes.length).toBeGreaterThanOrEqual(3)
      for (const { method, path } of routes) {
        const response = await http()[method](path)

        expect([method, path, response.status]).toEqual([method, path, 401])
        expect(response.body.error.code).toBe('invalid_token')
        expect(response.headers['www-authenticate']).toBe('Bearer')
      }
    })

    it.each([
      ['an unknown token', () => `Bearer ${generateToken().token}`],
      ['a malformed token', () => 'Bearer phk_nope'],
      ['the token without the scheme', () => tokenA],
      ['the token in the wrong scheme', () => `Basic ${tokenA}`]
    ])('refuses %s', async (_case, header) => {
      const response = await http().get(OFFERS).set('Authorization', header())

      expect(response.status).toBe(401)
    })

    it('does not accept the token in the query string or the body', async () => {
      const inQuery = await http().get(`${OFFERS}?token=${tokenA}`)
      const inBody = await http().put(CREDENTIAL).send({ token: tokenA })

      expect([inQuery.status, inBody.status]).toEqual([401, 401])
    })

    it('refuses a revoked token at once', async () => {
      expect((await http().get(OFFERS).set(as(tokenA))).status).toBe(200)

      await tokens.revoke(
        { storeId: storeA.id, prefix: tokenA.slice(4, 12) },
        TEST_ACTOR
      )

      expect((await http().get(OFFERS).set(as(tokenA))).status).toBe(401)
    })

    it('gives the same answer for unknown, revoked and malformed tokens', async () => {
      const revoked = await tokenFor(storeA, ALL)
      await tokens.revoke(
        { storeId: storeA.id, prefix: revoked.slice(4, 12) },
        TEST_ACTOR
      )
      const answers = await Promise.all(
        [revoked, generateToken().token, 'phk_nope'].map((token) =>
          http().get(OFFERS).set(as(token))
        )
      )

      expect(new Set(answers.map((a) => JSON.stringify(a.body.error))).size)
        .toBe(1)
    })
  })

  describe('scopes', () => {
    it('lets a read-only token read but not set the key', async () => {
      const readOnly = await tokenFor(storeA, ['prices:read'])

      expect((await http().get(OFFERS).set(as(readOnly))).status).toBe(200)
      expect((await http().get(CREDENTIAL).set(as(readOnly))).status).toBe(200)

      const response = await http()
        .put(CREDENTIAL)
        .set(as(readOnly))
        .send({ apiKey: server.acceptedKey })

      expect(response.status).toBe(403)
      expect(response.body.error.code).toBe('insufficient_scope')
      expect(server.requests).toEqual([])
    })

    it('does not let a write-only token read', async () => {
      const writeOnly = await tokenFor(storeA, ['credentials:write'])

      expect((await http().get(OFFERS).set(as(writeOnly))).status).toBe(403)
      expect((await http().get(CREDENTIAL).set(as(writeOnly))).status).toBe(403)
    })
  })

  describe('KuantoKusta key', () => {
    const setKey = (token: string, body: unknown) =>
      http().put(CREDENTIAL).set(as(token)).send(body as object)

    it('starts as not configured', async () => {
      const response = await http().get(CREDENTIAL).set(as(tokenA))

      expect(response.body).toEqual({
        provider: 'kuantokusta',
        configured: false,
        lastFour: null,
        updatedAt: null
      })
    })

    it('stores a key KuantoKusta accepts, and never gives it back', async () => {
      const response = await setKey(tokenA, { apiKey: server.acceptedKey })

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({
        provider: 'kuantokusta',
        configured: true,
        lastFour: '0001'
      })
      expect(server.requests).toEqual([
        {
          method: 'GET',
          path: '/api/v2/kms/offers?page=1&maxResultsPerPage=1',
          apiKey: server.acceptedKey
        }
      ])

      const status = await http().get(CREDENTIAL).set(as(tokenA))

      expect(status.body).toMatchObject({ configured: true, lastFour: '0001' })
      for (const answer of [response, status]) {
        expect(JSON.stringify([answer.body, answer.headers])).not.toContain(
          server.acceptedKey
        )
      }
    })

    it('stores it for the token\'s store only', async () => {
      await setKey(tokenA, { apiKey: server.acceptedKey })

      const other = await http().get(CREDENTIAL).set(as(tokenB))

      expect(other.body.configured).toBe(false)
    })

    it('ignores a store named in the request: the token decides', async () => {
      const response = await http()
        .put(`${CREDENTIAL}?storeId=${storeB.id}`)
        .set(as(tokenA))
        .set('x-store-id', storeB.id)
        .send({ apiKey: server.acceptedKey, storeId: storeB.id })

      // An unknown field is refused, not silently accepted.
      expect(response.status).toBe(400)
      expect((await http().get(CREDENTIAL).set(as(tokenB))).body.configured)
        .toBe(false)
    })

    it('does not store a key KuantoKusta refuses', async () => {
      const response = await setKey(tokenA, { apiKey: 'kk-wrong-key-9999' })

      expect(response.status).toBe(422)
      expect(response.body.error.code).toBe('kk_key_rejected')
      expect(JSON.stringify(response.body)).not.toContain('kk-wrong-key')
      expect((await http().get(CREDENTIAL).set(as(tokenA))).body.configured)
        .toBe(false)
    })

    it('does not store a key it could not verify', async () => {
      server.failNext(3, 503)

      const response = await setKey(tokenA, { apiKey: server.acceptedKey })

      expect(response.status).toBe(503)
      expect(response.body.error.code).toBe('kk_unavailable')
      expect((await http().get(CREDENTIAL).set(as(tokenA))).body.configured)
        .toBe(false)
    })

    it('keeps the previous key when the new one is refused', async () => {
      await setKey(tokenA, { apiKey: server.acceptedKey })
      await setKey(tokenA, { apiKey: 'kk-wrong-key-9999' })

      const status = await http().get(CREDENTIAL).set(as(tokenA))

      expect(status.body).toMatchObject({ configured: true, lastFour: '0001' })
    })

    it.each([
      ['no body', undefined],
      ['an empty object', {}],
      ['a key that is not text', { apiKey: 12345678 }],
      ['an empty key', { apiKey: '' }],
      ['a key that is too long', { apiKey: 'k'.repeat(513) }],
      ['an unknown field', { apiKey: 'kk-test-key-0001', extra: true }],
      ['a list', [{ apiKey: 'kk-test-key-0001' }]]
    ])('answers 400 to %s, without calling KuantoKusta', async (_case, body) => {
      const response = await setKey(tokenA, body)

      expect(response.status).toBe(400)
      expect(response.body.error.code).toBe('invalid_request')
      expect(server.requests).toEqual([])
    })

    it('does not echo the key in a validation error', async () => {
      const response = await setKey(tokenA, {
        apiKey: 'kk-secret with a space'
      })

      expect(response.status).toBe(400)
      expect(JSON.stringify(response.body)).not.toContain('kk-secret')
    })

    it('answers malformed JSON without repeating it', async () => {
      const response = await http()
        .put(CREDENTIAL)
        .set(as(tokenA))
        .set('content-type', 'application/json')
        .send('{"apiKey": "kk-secret-in-broken-json')

      expect(response.status).toBe(400)
      expect(response.body.error.code).toBe('bad_request')
      expect(JSON.stringify(response.body)).not.toContain('kk-secret')
    })

    it('limits how many keys can be tried per store', async () => {
      const statuses: number[] = []
      for (let attempt = 0; attempt < 7; attempt++) {
        const response = await setKey(tokenA, { apiKey: `kk-guess-${attempt}000` })
        statuses.push(response.status)
      }

      expect(statuses).toEqual([422, 422, 422, 422, 422, 429, 429])
      expect(server.requests).toHaveLength(5)
      // The limit is per store: another store is not affected.
      expect((await setKey(tokenB, { apiKey: server.acceptedKey })).status)
        .toBe(200)
    })

    it('records who replaced the key, and not the key', async () => {
      await setKey(tokenA, { apiKey: server.acceptedKey })

      const [event] = await prisma.audit_events.findMany({
        where: { store_id: storeA.id, action: 'credential.replaced' }
      })

      expect(event).toMatchObject({
        actor_type: 'api_token',
        actor_label: tokenA.slice(4, 12),
        target: 'kuantokusta'
      })
      expect(JSON.stringify(event.details)).not.toContain(server.acceptedKey)
    })
  })

  describe('offers', () => {
    const syncStore = async (store: TestStore, token: string, list: unknown[]) => {
      await http().put(CREDENTIAL).set(as(token)).send({
        apiKey: server.acceptedKey
      })
      server.offers = list
      await app.get(OffersSyncService).sync(store.id, TEST_ACTOR)
    }

    it('lists the store\'s offers, and nothing of another store', async () => {
      await syncStore(storeA, tokenA, [products.offer(1), products.offer(2)])
      await syncStore(storeB, tokenB, [
        products.offer(3, { productId: 'p-7-00003' })
      ])

      const a = await http().get(OFFERS).set(as(tokenA))
      const b = await http().get(OFFERS).set(as(tokenB))

      expect(a.status).toBe(200)
      expect(a.body.offers.map((o: { offerRef: string }) => o.offerRef))
        .toEqual(['p-9-30001', 'p-9-30002'])
      expect(b.body.offers.map((o: { offerRef: string }) => o.offerRef))
        .toEqual(['p-7-00003'])
      expect(a.body.offers[0]).toEqual({
        id: expect.stringMatching(/^\d+$/),
        offerRef: 'p-9-30001',
        sku: '6800001',
        ean: '5600000000001',
        name: 'Produto de teste 1',
        storeUrl: 'https://loja.example/produto/teste-1/',
        productUrl: `https://www.kuantokusta.pt/p/${products.base + 1}/produto-1`,
        priceCents: 1034,
        stock: 13,
        isTopBox: false,
        listingStatus: 'listed',
        kkUpdatedAt: '2026-10-07T23:49:45.000Z',
        lastSeenAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/)
      })
    })

    it('pages with a cursor', async () => {
      await syncStore(
        storeA,
        tokenA,
        Array.from({ length: 5 }, (_, n) => products.offer(n + 10))
      )

      const first = await http().get(`${OFFERS}?limit=2`).set(as(tokenA))
      const second = await http()
        .get(`${OFFERS}?limit=2&after=${first.body.nextCursor}`)
        .set(as(tokenA))
      const third = await http()
        .get(`${OFFERS}?limit=2&after=${second.body.nextCursor}`)
        .set(as(tokenA))

      expect([first, second, third].map((r) => r.body.offers.length))
        .toEqual([2, 2, 1])
      expect(third.body.nextCursor).toBeNull()
    })

    it('cannot reach another store\'s offers through the cursor', async () => {
      await syncStore(storeA, tokenA, [products.offer(20)])
      await syncStore(storeB, tokenB, [
        products.offer(21, { productId: 'p-7-00021' })
      ])

      // A cursor far before both: store B still sees only its own.
      const response = await http().get(`${OFFERS}?after=1`).set(as(tokenB))

      expect(response.body.offers.map((o: { offerRef: string }) => o.offerRef))
        .toEqual(['p-7-00021'])
    })

    it('filters by listing status', async () => {
      await syncStore(storeA, tokenA, [products.offer(30), products.offer(31)])
      server.offers = [products.offer(30)]
      await app.get(OffersSyncService).sync(storeA.id, TEST_ACTOR)

      const count = async (status: string) =>
        (await http().get(`${OFFERS}?status=${status}`).set(as(tokenA))).body
          .offers.length

      expect(await count('listed')).toBe(1)
      expect(await count('delisted')).toBe(1)
      expect(await count('all')).toBe(2)
    })

    it.each([
      'limit=0',
      'limit=201',
      'limit=abc',
      'limit=1.5',
      'after=abc',
      'after=-1',
      'after=1%20OR%201=1',
      'status=deleted',
      'storeId=00000000-0000-0000-0000-000000000000',
      'unknown=1'
    ])('answers 400 to ?%s', async (query) => {
      const response = await http().get(`${OFFERS}?${query}`).set(as(tokenA))

      expect(response.status).toBe(400)
      expect(response.body.error.code).toBe('invalid_request')
    })
  })

  describe('every answer', () => {
    it('carries a request id, also on errors', async () => {
      const ok = await http().get(OFFERS).set(as(tokenA))
      const refused = await http().get(OFFERS)

      expect(ok.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
      expect(refused.body.requestId).toBe(refused.headers['x-request-id'])
    })

    it('reuses a well-formed request id from the caller, and only that', async () => {
      const kept = await http().get(OFFERS).set('x-request-id', 'wp-req-12345678')
      const replaced = await http()
        .get(OFFERS)
        .set('x-request-id', 'bad id\twith spaces')

      expect(kept.headers['x-request-id']).toBe('wp-req-12345678')
      expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('refuses a body that is too large, in the same shape', async () => {
      const response = await http()
        .put(CREDENTIAL)
        .set(as(tokenA))
        .send({ apiKey: 'k'.repeat(200_000) })

      expect(response.status).toBe(413)
      expect(response.body.error.code).toBe('payload_too_large')
      expect(server.requests).toEqual([])
    })

    it('does not advertise the framework and forbids content sniffing', async () => {
      const response = await http().get('/health/live')

      expect(response.status).toBe(200)
      expect(response.headers['x-powered-by']).toBeUndefined()
      expect(response.headers['x-content-type-options']).toBe('nosniff')
    })

    it('answers an unknown address in the same shape, with no CORS headers', async () => {
      const response = await http()
        .get('/v1/plugin/nothing-here')
        .set('Origin', 'https://evil.example')

      expect(response.status).toBe(404)
      expect(response.body.error.code).toBe('not_found')
      expect(response.headers['access-control-allow-origin']).toBeUndefined()
    })
  })
})

type Method = 'get' | 'put' | 'post' | 'patch' | 'delete'

/** The routes the running application actually registered. */
function registeredRoutes(
  app: INestApplication
): { method: Method, path: string }[] {
  const router = app.getHttpAdapter().getInstance().router as {
    stack: { route?: { path: string, methods: Record<string, boolean> } }[]
  }
  return router.stack.flatMap((layer) => {
    const { route } = layer
    if (!route || typeof route.path !== 'string') return []
    return Object.keys(route.methods)
      .filter((method) => method !== '_all')
      .map((method) => ({ method: method as Method, path: route.path }))
  })
}
