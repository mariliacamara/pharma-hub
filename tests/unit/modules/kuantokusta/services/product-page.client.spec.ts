import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  describe,
  beforeAll,
  beforeEach,
  afterAll,
  it,
  expect
} from '@jest/globals'
import { Logger } from '@nestjs/common'

import { ProductPageClient } from '#/modules/kuantokusta/services/product-page.client'

import {
  CHALLENGE_HTML,
  FakeKkSite
} from '../../../../support/fake-kk-site'

const USER_AGENT = 'PharmaHubPriceReport/1.0 (price report for partner stores)'
const PRODUCT = 'https://www.kuantokusta.pt/p/3400001/ben-u-ron-500'
const ZINCOMED = { storeName: 'Zincomed', storeSlug: 'zincomed', price: 9.34 }

// Talks to a fake website on 127.0.0.1. Nothing leaves this machine.
describe('ProductPageClient', () => {
  const site = new FakeKkSite()
  let client: ProductPageClient

  beforeAll(async () => {
    Logger.overrideLogger(false)
    await site.start()
  })

  afterAll(async () => {
    await site.stop()
  })

  beforeEach(() => {
    site.reset()
    client = new ProductPageClient({ baseUrl: site.url, userAgent: USER_AGENT })
  })

  describe('fetchPage', () => {
    it('reads the offers, saying who it is and asking for nothing but HTML', async () => {
      site.page(3400001, [ZINCOMED])

      const reading = await client.fetchPage(PRODUCT)

      expect(reading.outcome).toBe('ok')
      expect(reading.offers).toHaveLength(1)
      expect(site.requests).toEqual([
        {
          path: '/p/3400001/ben-u-ron-500',
          userAgent: USER_AGENT,
          accept: 'text/html'
        }
      ])
    })

    it('goes to the configured website only, whatever host the address names', async () => {
      // A second server, standing for "somewhere else".
      let reached = false
      const elsewhere = createServer((_request, response) => {
        reached = true
        response.end()
      })
      await new Promise<void>((resolve) => {
        elsewhere.listen(0, '127.0.0.1', resolve)
      })
      const { port } = elsewhere.address() as AddressInfo

      const readings = await Promise.all(
        [
          `http://127.0.0.1:${port}/p/3400001/x`,
          `https://127.0.0.1:${port}/p/3400001/x`,
          `https://www.kuantokusta.pt@127.0.0.1:${port}/p/3400001/x`,
          'https://www.kuantokusta.pt.evil.example/p/3400001/x',
          'https://www.kuantokusta.pt/api/products/3400001',
          'https://www.kuantokusta.pt/p/3400001/x?next=/api',
          'https://www.kuantokusta.pt/p/3400001/../../api/x',
          'not a url'
        ].map((url) => client.fetchPage(url))
      )
      elsewhere.close()

      expect(reached).toBe(false)
      expect(site.requests).toEqual([])
      expect(readings.every((reading) => reading.outcome === 'http_error'))
        .toBe(true)
    })

    it.each([
      [403, 'blocked'],
      [429, 'blocked'],
      [404, 'not_found'],
      [410, 'not_found'],
      [500, 'http_error'],
      [503, 'http_error']
    ])('reports a %i as %s, once, without trying again', async (status, outcome) => {
      site.pageStatus(3400001, status)

      const reading = await client.fetchPage(PRODUCT)

      expect(reading).toEqual({ outcome, httpStatus: status, offers: null })
      expect(site.pageRequests).toHaveLength(1)
    })

    it('reports a challenge page as a refusal', async () => {
      site.pageHtml(3400001, CHALLENGE_HTML)

      expect((await client.fetchPage(PRODUCT)).outcome).toBe('blocked')
    })

    it('reports a dropped connection as a network error', async () => {
      site.pageDrop(3400001)

      expect(await client.fetchPage(PRODUCT)).toEqual({
        outcome: 'network_error',
        httpStatus: null,
        offers: null
      })
    })

    it('gives up on a page that takes too long', async () => {
      const slow = createServer(() => {
        // Never answers.
      })
      await new Promise<void>((resolve) => {
        slow.listen(0, '127.0.0.1', resolve)
      })
      const { port } = slow.address() as AddressInfo
      const impatient = new ProductPageClient({
        baseUrl: `http://127.0.0.1:${port}`,
        userAgent: USER_AGENT,
        timeoutMs: 100
      })

      const reading = await impatient.fetchPage(PRODUCT)
      slow.closeAllConnections()
      slow.close()

      expect(reading.outcome).toBe('network_error')
    })

    it('refuses a page far larger than any product page', async () => {
      site.pageHtml(3400001, 'x'.repeat(5 * 1024 * 1024))

      expect((await client.fetchPage(PRODUCT)).outcome).toBe('network_error')
    })

    it('follows a redirect to the same product under a new name', async () => {
      site.pageRedirect(3400001, '/p/3400001/ben-u-ron-500-mg-novo')
      let asked = 0
      site.onPage = () => {
        // The second request, to the new address, gets the page.
        if (++asked === 2) site.page(3400001, [ZINCOMED])
      }

      const reading = await client.fetchPage(PRODUCT)

      expect(reading.outcome).toBe('ok')
      expect(site.pageRequests).toEqual([
        '/p/3400001/ben-u-ron-500',
        '/p/3400001/ben-u-ron-500-mg-novo'
      ])
    })

    it.each([
      ['another product', '/p/3400002/outro'],
      ['another kind of page', '/search?q=ben-u-ron'],
      ['the API', '/api/products/3400001'],
      ['the same product with a query string', '/p/3400001/x?_pxhc=1'],
      ['another site', 'https://evil.example/p/3400001/ben-u-ron-500'],
      ['a challenge elsewhere', '//challenge.example/p/3400001/x']
    ])('does not follow a redirect to %s', async (_what, location) => {
      site.pageRedirect(3400001, location)

      const reading = await client.fetchPage(PRODUCT)

      expect(reading).toEqual({
        outcome: 'http_error',
        httpStatus: 301,
        offers: null
      })
      expect(site.pageRequests).toEqual(['/p/3400001/ben-u-ron-500'])
    })

    it('follows one redirect, not a chain', async () => {
      site.pageRedirect(3400001, '/p/3400001/outra-vez')

      const reading = await client.fetchPage(PRODUCT)

      expect(reading.outcome).toBe('http_error')
      expect(site.pageRequests).toHaveLength(2)
    })
  })

  describe('fetchRobots', () => {
    it('reads the rules, saying who it is', async () => {
      site.robots = 'User-agent: *\nDisallow: /api/*\nCrawl-delay: 7\n'

      const answer = await client.fetchRobots()

      expect(answer.kind).toBe('rules')
      expect(site.requests).toEqual([
        { path: '/robots.txt', userAgent: USER_AGENT, accept: 'text/plain' }
      ])
      if (answer.kind !== 'rules') return
      expect(client.isAllowed(answer.groups, PRODUCT)).toBe(true)
      expect(client.crawlDelaySeconds(answer.groups)).toBe(7)
    })

    it('takes a missing robots.txt as no restrictions', async () => {
      site.robots = { status: 404 }

      expect(await client.fetchRobots()).toEqual({ kind: 'rules', groups: [] })
    })

    it.each([401, 403])('takes a %i as a refusal of this client', async (status) => {
      site.robots = { status }

      expect(await client.fetchRobots()).toEqual({
        kind: 'blocked',
        httpStatus: status
      })
    })

    it.each([500, 503, 301, 429])(
      'takes a %i as "rules unknown", which allows nothing',
      async (status) => {
        site.robots = { status }

        expect(await client.fetchRobots()).toEqual({
          kind: 'unavailable',
          reason: `status ${status}`
        })
      }
    )

    it('takes no answer as "rules unknown"', async () => {
      site.robots = 'drop'

      expect(await client.fetchRobots()).toEqual({
        kind: 'unavailable',
        reason: 'network error'
      })
    })

    it('refuses a robots.txt far larger than any real one', async () => {
      site.robots = `User-agent: *\n${'Disallow: /x\n'.repeat(60_000)}`

      expect((await client.fetchRobots()).kind).toBe('unavailable')
    })
  })

  describe('isAllowed', () => {
    it('obeys the rules written for everyone', async () => {
      site.robots = 'User-agent: *\nDisallow: /p/\n'
      const answer = await client.fetchRobots()
      if (answer.kind !== 'rules') throw new Error('expected rules')

      expect(client.isAllowed(answer.groups, PRODUCT)).toBe(false)
    })

    it('obeys rules written for this client by name', async () => {
      site.robots
        = 'User-agent: *\nAllow: /\n\n'
          + 'User-agent: PharmaHubPriceReport\nDisallow: /\n'
      const answer = await client.fetchRobots()
      if (answer.kind !== 'rules') throw new Error('expected rules')

      expect(client.clientName).toBe('PharmaHubPriceReport')
      expect(client.isAllowed(answer.groups, PRODUCT)).toBe(false)
    })

    it('never allows something that is not a product page', async () => {
      const answer = await client.fetchRobots()
      if (answer.kind !== 'rules') throw new Error('expected rules')

      expect(
        client.isAllowed(answer.groups, 'https://www.kuantokusta.pt/api/x')
      ).toBe(false)
      expect(client.isAllowed(answer.groups, 'nonsense')).toBe(false)
    })

    it('allows product pages under the real robots.txt of 2026-10-08', async () => {
      site.robots = readFileSync('tests/fixtures/robots-kuantokusta.txt', 'utf8')
      const answer = await client.fetchRobots()
      if (answer.kind !== 'rules') throw new Error('expected rules')

      expect(client.isAllowed(answer.groups, PRODUCT)).toBe(true)
      // The real file disallows addresses ending in a hyphen.
      expect(
        client.isAllowed(
          answer.groups,
          'https://www.kuantokusta.pt/p/3400001/ben-u-ron-'
        )
      ).toBe(false)
      expect(client.crawlDelaySeconds(answer.groups)).toBe(0)
    })
  })
})
