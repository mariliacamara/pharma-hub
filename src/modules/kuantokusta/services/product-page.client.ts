import { Logger } from '@nestjs/common'

import { readPageResponse } from '../domain/page-reading'
import type { PageReading } from '../domain/page-reading'
import { crawlDelaySeconds, isPathAllowed, parseRobots } from '../domain/robots'
import type { RobotsGroup } from '../domain/robots'
import { readProductUrl } from '../domain/seller-offer'

/**
 * Reads product pages of KuantoKusta's public website.
 *
 * The rules it follows are in docs/kuantokusta.md ("Collection rules"). In
 * short: it says who it is, it asks robots.txt first, it reads the HTML page
 * and nothing else, and it never tries to get around a refusal.
 *
 * It can only ever talk to the one website it was configured with. A product
 * URL contributes its path, after being checked again; the host always comes
 * from the configuration.
 */
export interface ProductPageClientOptions {
  /** For example https://www.kuantokusta.pt */
  baseUrl: string
  userAgent: string
  timeoutMs?: number
}

/** What robots.txt says about this client. */
export type RobotsAnswer
  = | { kind: 'rules', groups: RobotsGroup[] }
  /** The site refused to serve robots.txt to this client. */
    | { kind: 'blocked', httpStatus: number }
  /** The file could not be obtained, so nothing may be assumed allowed. */
    | { kind: 'unavailable', reason: string }

const MAX_PAGE_BYTES = 4 * 1024 * 1024
const MAX_ROBOTS_BYTES = 512 * 1024

export class ProductPageClient {
  private readonly logger = new Logger(ProductPageClient.name)
  private readonly origin: string
  private readonly userAgent: string
  private readonly timeoutMs: number

  constructor(options: ProductPageClientOptions) {
    this.origin = new URL(options.baseUrl).origin
    this.userAgent = options.userAgent
    this.timeoutMs = options.timeoutMs ?? 20_000
  }

  /** The name robots.txt rules are matched against: "Name" of "Name/1.0". */
  get clientName(): string {
    return this.userAgent.split('/')[0]
  }

  async fetchRobots(): Promise<RobotsAnswer> {
    let response: Response
    try {
      response = await this.get('/robots.txt', 'text/plain')
    } catch (error) {
      return { kind: 'unavailable', reason: describeNetworkError(error) }
    }

    if (response.status === 401 || response.status === 403) {
      await discard(response)
      return { kind: 'blocked', httpStatus: response.status }
    }
    // No robots.txt at all means no restrictions.
    if (response.status === 404 || response.status === 410) {
      await discard(response)
      return { kind: 'rules', groups: [] }
    }
    // Anything else (a server error, a redirect) leaves the rules unknown,
    // and unknown rules are treated as "do not read".
    if (response.status !== 200) {
      await discard(response)
      return { kind: 'unavailable', reason: `status ${response.status}` }
    }

    try {
      const text = await readBody(response, MAX_ROBOTS_BYTES)
      return { kind: 'rules', groups: parseRobots(text) }
    } catch (error) {
      return { kind: 'unavailable', reason: describeNetworkError(error) }
    }
  }

  /** Whether robots.txt lets this client read the page. */
  isAllowed(groups: readonly RobotsGroup[], productUrl: string): boolean {
    const path = this.pathOf(productUrl)
    return path !== null && isPathAllowed(groups, this.clientName, path)
  }

  /** The pause robots.txt asks for between requests, in seconds. 0 = none. */
  crawlDelaySeconds(groups: readonly RobotsGroup[]): number {
    return crawlDelaySeconds(groups, this.clientName)
  }

  /**
   * Reads one product page. Never throws: whatever happens is one of the
   * outcomes a snapshot can record.
   */
  async fetchPage(productUrl: string): Promise<PageReading> {
    const product = readProductUrl(productUrl)
    if (!product) return failure('http_error', null)

    const startedAt = Date.now()
    const reading = await this.read(new URL(productUrl).pathname, product.externalId)
    this.logger.log(
      `GET /p/${product.externalId} ${reading.outcome} `
      + `status=${reading.httpStatus ?? '-'} ms=${Date.now() - startedAt}`
    )
    return reading
  }

  private async read(path: string, externalId: number): Promise<PageReading> {
    try {
      let response = await this.get(path, 'text/html')

      // A product keeps its number when its name changes, and the old
      // address then redirects to the new one. That one hop is followed,
      // and only to the same product on the same site.
      if (response.status >= 300 && response.status < 400) {
        const next = this.sameProductPath(response, externalId)
        await discard(response)
        if (next === null) return failure('http_error', response.status)
        response = await this.get(next, 'text/html')
        if (response.status >= 300 && response.status < 400) {
          await discard(response)
          return failure('http_error', response.status)
        }
      }

      const html = await readBody(response, MAX_PAGE_BYTES)
      return readPageResponse(response.status, html)
    } catch {
      return failure('network_error', null)
    }
  }

  private get(path: string, accept: string): Promise<Response> {
    return fetch(`${this.origin}${path}`, {
      method: 'GET',
      headers: { 'user-agent': this.userAgent, 'accept': accept },
      // Redirects are looked at one by one, never followed blindly.
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs)
    })
  }

  /** The path of a product URL, if it is one. */
  private pathOf(productUrl: string): string | null {
    return readProductUrl(productUrl) ? new URL(productUrl).pathname : null
  }

  /** The path a redirect points to, if it is the same product on this site. */
  private sameProductPath(response: Response, externalId: number): string | null {
    const location = response.headers.get('location')
    if (!location) return null

    let target: URL
    try {
      target = new URL(location, this.origin)
    } catch {
      return null
    }
    if (target.origin !== this.origin || target.search !== '') return null

    // Checked as if it were on the real site, with the same strict rule.
    const asProduct = readProductUrl(
      `https://www.kuantokusta.pt${target.pathname}`
    )
    return asProduct?.externalId === externalId ? target.pathname : null
  }
}

function failure(
  outcome: 'http_error' | 'network_error',
  httpStatus: number | null
): PageReading {
  return { outcome, httpStatus, offers: null }
}

function describeNetworkError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    if (error.name === 'TimeoutError') return 'timeout'
  }
  return 'network error'
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The response is being thrown away either way.
  }
}

/** Reads the body as text, up to a size no real page reaches. */
async function readBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return ''

  const chunks: Uint8Array[] = []
  let size = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new Error('The response is too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}
