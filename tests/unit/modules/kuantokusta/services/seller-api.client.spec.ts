import {
  describe,
  beforeAll,
  beforeEach,
  afterAll,
  it,
  expect
} from '@jest/globals'
import { Logger } from '@nestjs/common'

import {
  KkKeyRejectedError,
  KkRateLimitedError,
  KkSellerApiClient,
  KkUnavailableError,
  KkUnexpectedResponseError
} from '#/modules/kuantokusta/services/seller-api.client'

import { FakeKkServer, fakeOffer } from '../../../../support/fake-kk-server'

// Talks to a fake Seller API on 127.0.0.1. Nothing leaves this machine.
describe('KkSellerApiClient', () => {
  const server = new FakeKkServer()
  let waits: number[]
  let client: KkSellerApiClient

  const newClient = (options = {}) =>
    new KkSellerApiClient({
      baseUrl: server.url,
      // Records the waits instead of waiting.
      sleep: async (ms) => {
        waits.push(ms)
      },
      ...options
    })

  beforeAll(async () => {
    Logger.overrideLogger(false)
    await server.start()
  })

  afterAll(async () => {
    await server.stop()
  })

  beforeEach(() => {
    server.reset()
    waits = []
    client = newClient()
  })

  it('reads every page until one comes back short', async () => {
    server.offers = Array.from({ length: 250 }, (_, n) => fakeOffer(n))

    const offers = await client.fetchAllOffers(server.acceptedKey)

    expect(offers).toHaveLength(250)
    expect(server.requests.map((request) => request.path)).toEqual([
      '/api/v2/kms/offers?page=1&maxResultsPerPage=100',
      '/api/v2/kms/offers?page=2&maxResultsPerPage=100',
      '/api/v2/kms/offers?page=3&maxResultsPerPage=100'
    ])
  })

  it('asks for one more page when the last one was exactly full', async () => {
    server.offers = Array.from({ length: 100 }, (_, n) => fakeOffer(n))

    expect(await client.fetchAllOffers(server.acceptedKey)).toHaveLength(100)
    expect(server.requests).toHaveLength(2)
  })

  it('returns an empty list for a store without offers', async () => {
    expect(await client.fetchAllOffers(server.acceptedKey)).toEqual([])
  })

  it('only ever sends GET, with the key in the x-api-key header', async () => {
    server.offers = Array.from({ length: 150 }, (_, n) => fakeOffer(n))

    await client.verifyKey(server.acceptedKey)
    await client.fetchAllOffers(server.acceptedKey)

    expect(server.requests.length).toBeGreaterThan(0)
    for (const request of server.requests) {
      expect(request.method).toBe('GET')
      expect(request.path.startsWith('/api/v2/kms/offers?')).toBe(true)
      expect(request.apiKey).toBe(server.acceptedKey)
      expect(request.path).not.toContain(server.acceptedKey)
    }
  })

  it('verifies a key with a single small request', async () => {
    await expect(client.verifyKey(server.acceptedKey)).resolves.toBeUndefined()

    expect(server.requests.map((request) => request.path)).toEqual([
      '/api/v2/kms/offers?page=1&maxResultsPerPage=1'
    ])
  })

  it('tries only once when verifying, even if the server is failing', async () => {
    server.failNext(1, 503)

    await expect(client.verifyKey(server.acceptedKey)).rejects.toThrow(
      new KkUnavailableError('status 503')
    )
    expect(server.requests).toHaveLength(1)
    expect(waits).toEqual([])
  })

  it('gives up on a list that takes longer than its deadline', async () => {
    server.offers = Array.from({ length: 300 }, (_, n) => fakeOffer(n))
    const realNow = Date.now
    let offset = 0
    Date.now = () => realNow() + offset
    try {
      // Every pause "lasts" 40 seconds, so the second page is already late.
      const slow = newClient({
        deadlineMs: 60_000,
        rateWindows: [{ limit: 1, periodMs: 40_000 }],
        sleep: async (ms: number) => {
          offset += ms
        }
      })

      await expect(slow.fetchAllOffers(server.acceptedKey)).rejects.toThrow(
        new KkUnavailableError('the list was not complete after 1 minutes')
      )
      expect(server.requests.length).toBeLessThan(4)
    } finally {
      Date.now = realNow
    }
  })

  it('refuses a list whose pages add up to too much', async () => {
    // Eleven pages of just under the per-page limit: each is fine alone.
    const big = 'x'.repeat(4.9 * 1024 * 1024)
    for (let page = 0; page < 11; page++) {
      server.queued.push((response) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify([
            `${page}:${big}`,
            ...Array.from({ length: 99 }, (_, n) => `${page}-${n}`)
          ])
        )
      })
    }

    await expect(client.fetchAllOffers(server.acceptedKey)).rejects.toThrow(
      new KkUnexpectedResponseError('the whole list is too large')
    )
  })

  it('reports a refused key at once, without retrying', async () => {
    await expect(client.verifyKey('wrong-key')).rejects.toThrow(
      KkKeyRejectedError
    )
    expect(server.requests).toHaveLength(1)

    server.failNext(1, 403)
    await expect(client.fetchAllOffers(server.acceptedKey)).rejects.toThrow(
      KkKeyRejectedError
    )
    expect(server.requests).toHaveLength(2)
  })

  it.each([401, 403])(
    'does not blame the key for a %i that is not from the API',
    async (status) => {
      // What a firewall in front of the API sends when it blocks a caller.
      server.queued.push((response) => {
        response.writeHead(status, { 'content-type': 'text/html' })
        response.end('<html><title>Access denied</title></html>')
      })

      await expect(client.verifyKey(server.acceptedKey)).rejects.toThrow(
        new KkUnexpectedResponseError(
          `status ${status} that did not come from the API`
        )
      )
      expect(server.requests).toHaveLength(1)
    }
  )

  it('waits as long as a 429 asks, then carries on', async () => {
    server.offers = [fakeOffer(1)]
    server.failNext(1, 429, { 'retry-after': '7' })

    expect(await client.fetchAllOffers(server.acceptedKey)).toHaveLength(1)
    expect(waits).toEqual([8000])
  })

  it('assumes the 30-second block when a 429 does not say how long', async () => {
    server.offers = [fakeOffer(1)]
    server.failNext(1, 429)

    await client.fetchAllOffers(server.acceptedKey)

    expect(waits).toEqual([31_000])
  })

  it('does not wait longer than its own cap, whatever the server says', async () => {
    server.failNext(1, 429, { 'retry-after': '86400' })

    await client.fetchAllOffers(server.acceptedKey)

    expect(waits).toEqual([60_000])
  })

  it('gives up when the rate limit persists', async () => {
    server.failNext(3, 429, { 'retry-after': '1' })

    await expect(client.fetchAllOffers(server.acceptedKey)).rejects.toThrow(
      KkRateLimitedError
    )
    expect(server.requests).toHaveLength(3)
  })

  it('retries a server error with a growing pause', async () => {
    server.offers = [fakeOffer(1)]
    server.failNext(2, 503)

    expect(await client.fetchAllOffers(server.acceptedKey)).toHaveLength(1)
    expect(waits).toHaveLength(2)
    expect(waits[0]).toBeGreaterThanOrEqual(500)
    expect(waits[0]).toBeLessThan(1000)
    expect(waits[1]).toBeGreaterThanOrEqual(1000)
    expect(waits[1]).toBeLessThan(2000)
  })

  it('gives up after three failed attempts', async () => {
    server.failNext(3, 500)

    await expect(client.fetchAllOffers(server.acceptedKey)).rejects.toThrow(
      new KkUnavailableError('status 500')
    )
    expect(server.requests).toHaveLength(3)
  })

  it('never returns part of the list when a later page fails', async () => {
    server.offers = Array.from({ length: 150 }, (_, n) => fakeOffer(n))
    server.queued.push((response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(server.offers.slice(0, 100)))
    })
    server.failNext(3, 502)

    await expect(client.fetchAllOffers(server.acceptedKey)).rejects.toThrow(
      KkUnavailableError
    )
  })

  it('times out instead of hanging', async () => {
    server.queued.push(() => {
      // Never answers.
    })
    const impatient = newClient({ timeoutMs: 80, maxAttempts: 1 })

    await expect(impatient.verifyKey(server.acceptedKey)).rejects.toThrow(
      new KkUnavailableError('timeout')
    )
  })

  it('reports an unreachable server', async () => {
    // A port that was just in use and is now closed.
    const closed = new FakeKkServer()
    await closed.start()
    const baseUrl = closed.url
    await closed.stop()
    const nowhere = new KkSellerApiClient({
      baseUrl,
      maxAttempts: 2,
      sleep: async () => undefined
    })

    await expect(nowhere.verifyKey('any')).rejects.toThrow(
      new KkUnavailableError('ECONNREFUSED')
    )
  })

  it('refuses to follow a redirect, so the key never goes elsewhere', async () => {
    const elsewhere = new FakeKkServer()
    await elsewhere.start()
    try {
      server.failNext(4, 302, {
        location: `${elsewhere.url}/v2/kms/offers?page=1&maxResultsPerPage=1`
      })

      await expect(client.verifyKey(server.acceptedKey)).rejects.toThrow(
        new KkUnavailableError('redirect refused')
      )
      await expect(client.fetchAllOffers(server.acceptedKey)).rejects.toThrow(
        new KkUnavailableError('redirect refused')
      )
      expect(elsewhere.requests).toEqual([])
    } finally {
      await elsewhere.stop()
    }
  })

  it.each([
    ['is not JSON', '<html>maintenance</html>'],
    ['is not a list', '{"offers":[]}'],
    ['is empty', '']
  ])('fails loudly when the answer %s', async (_case, body) => {
    server.queued.push((response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(body)
    })

    await expect(client.fetchAllOffers(server.acceptedKey)).rejects.toThrow(
      KkUnexpectedResponseError
    )
    expect(server.requests).toHaveLength(1)
  })

  it('refuses a response too large to be a real page', async () => {
    server.queued.push((response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(`["${'x'.repeat(6 * 1024 * 1024)}"]`)
    })

    await expect(client.fetchAllOffers(server.acceptedKey)).rejects.toThrow(
      new KkUnexpectedResponseError('the response is too large')
    )
  })

  it('treats an unexpected status as a change in the API', async () => {
    server.failNext(1, 404)

    await expect(client.fetchAllOffers(server.acceptedKey)).rejects.toThrow(
      new KkUnexpectedResponseError('status 404')
    )
  })

  it('stops if the API ignores the page number', async () => {
    server.offers = Array.from({ length: 100 }, (_, n) => fakeOffer(n))
    server.ignorePaging = true

    await expect(client.fetchAllOffers(server.acceptedKey)).rejects.toThrow(
      new KkUnexpectedResponseError('the same page came back twice')
    )
    expect(server.requests).toHaveLength(2)
  })

  it('stays under the published rate limits', async () => {
    server.offers = Array.from({ length: 1000 }, (_, n) => fakeOffer(n))
    // A clock the fake sleep advances, so the limiter sees time pass.
    const realNow = Date.now
    let offset = 0
    Date.now = () => realNow() + offset
    try {
      const paced = newClient({
        sleep: async (ms: number) => {
          waits.push(ms)
          offset += ms
        }
      })

      await paced.fetchAllOffers(server.acceptedKey)
    } finally {
      Date.now = realNow
    }

    // 11 requests: the fifth must wait for the one-second window.
    expect(server.requests).toHaveLength(11)
    expect(waits.length).toBeGreaterThan(0)
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThan(1000)
  })

  it('never puts the key in an error', async () => {
    const key = 'kk-secret-key-that-must-not-leak'
    server.failNext(4, 500)
    const failures: unknown[] = []

    for (const call of [
      () => client.verifyKey(key),
      () => client.fetchAllOffers(key)
    ]) {
      await call().catch((error: unknown) => failures.push(error))
    }

    expect(failures).toHaveLength(2)
    for (const failure of failures) {
      const text = `${String(failure)} ${JSON.stringify(failure)} ${
        (failure as Error).stack
      }`

      expect(text).not.toContain(key)
    }
  })
})
