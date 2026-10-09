import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A stand-in for KuantoKusta's public website, listening on 127.0.0.1.
 *
 * It serves robots.txt and product pages with the offers embedded the way
 * the real pages embed them (docs/kuantokusta.md). Tests switch on the
 * refusals and faults they want to see handled.
 */
export interface SiteRequest {
  path: string
  userAgent: string | undefined
  accept: string | undefined
}

export interface SiteOffer {
  storeName: string
  storeSlug: string
  sellerId?: number | null
  /** Euros, as the page shows them. */
  price: number
  shipping?: number | null
}

type Answer
  = | { kind: 'offers', offers: SiteOffer[] }
    | { kind: 'status', status: number, body?: string }
    | { kind: 'html', html: string }
    | { kind: 'redirect', location: string }
    | { kind: 'drop' }

export const ROBOTS_ALLOW_ALL = 'User-agent: *\nAllow: /\n'

export class FakeKkSite {
  /** The robots.txt body, or what to answer instead of one. */
  robots: string | { status: number } | 'drop' = ROBOTS_ALLOW_ALL
  /** Every request received, in order. */
  requests: SiteRequest[] = []
  /** Called on every product page request, for tests that react to one. */
  onPage: ((productId: number) => void) | undefined

  private readonly pages = new Map<number, Answer>()
  private fallback: Answer = { kind: 'status', status: 404 }
  private server: Server | undefined

  get url(): string {
    const { port } = this.server?.address() as AddressInfo
    return `http://127.0.0.1:${port}`
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      this.handle(request, response)
    })
    await new Promise<void>((resolve) => {
      this.server?.listen(0, '127.0.0.1', resolve)
    })
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections()
    await new Promise((resolve) => this.server?.close(resolve))
  }

  reset(): void {
    this.robots = ROBOTS_ALLOW_ALL
    this.requests = []
    this.onPage = undefined
    this.pages.clear()
    this.fallback = { kind: 'status', status: 404 }
  }

  /** The page of that product lists these offers. */
  page(productId: number, offers: SiteOffer[]): void {
    this.pages.set(productId, { kind: 'offers', offers })
  }

  /** The page of that product answers with that status. */
  pageStatus(productId: number, status: number, body?: string): void {
    this.pages.set(productId, { kind: 'status', status, body })
  }

  pageHtml(productId: number, html: string): void {
    this.pages.set(productId, { kind: 'html', html })
  }

  pageRedirect(productId: number, location: string): void {
    this.pages.set(productId, { kind: 'redirect', location })
  }

  /** The connection is closed without an answer. */
  pageDrop(productId: number): void {
    this.pages.set(productId, { kind: 'drop' })
  }

  /** What every page not set one by one answers. */
  everyOtherPage(status: number): void {
    this.fallback = { kind: 'status', status }
  }

  /** The paths of the product pages requested, in order. */
  get pageRequests(): string[] {
    return this.requests
      .map((request) => request.path)
      .filter((path) => path.startsWith('/p/'))
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? '/', 'http://fake')
    this.requests.push({
      path: url.pathname + url.search,
      userAgent: request.headers['user-agent'],
      accept: request.headers.accept
    })

    if (url.pathname === '/robots.txt') {
      if (this.robots === 'drop') {
        request.socket.destroy()
      } else if (typeof this.robots === 'string') {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end(this.robots)
      } else {
        response.writeHead(this.robots.status).end()
      }
      return
    }

    const product = /^\/p\/(\d+)\//.exec(url.pathname)
    if (!product) {
      response.writeHead(404).end()
      return
    }
    const productId = Number(product[1])
    this.onPage?.(productId)

    const answer = this.pages.get(productId) ?? this.fallback
    switch (answer.kind) {
      case 'offers':
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end(productPageHtml(answer.offers))
        return
      case 'html':
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end(answer.html)
        return
      case 'status':
        response.writeHead(answer.status, { 'content-type': 'text/html' })
        response.end(answer.body ?? '')
        return
      case 'redirect':
        response.writeHead(301, { location: answer.location }).end()
        return
      case 'drop':
        request.socket.destroy()
    }
  }
}

/**
 * A product page with the structure observed on KuantoKusta on 2026-10-08:
 * the offers inside the JSON of <script id="__NEXT_DATA__">.
 */
export function productPageHtml(offers: SiteOffer[]): string {
  const data = {
    props: {
      pageProps: {
        basePage: {
          product: {
            offers: offers.map((offer) => ({
              isHighlighted: false,
              sellerId: offer.sellerId === undefined ? null : offer.sellerId,
              price: offer.price,
              storeName: offer.storeName,
              storeSlug: offer.storeSlug,
              shipping: {
                expectedDeliveryDate: null,
                minimumPrice: offer.shipping ?? null
              },
              filters: { isMarketplace: false }
            }))
          }
        }
      }
    }
  }
  return `<!DOCTYPE html><html><head><title>Produto</title>
    <script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>
    </head><body><div id="__next"></div></body></html>`
}

/** What a bot protection service serves instead of the page. */
export const CHALLENGE_HTML
  = '<!DOCTYPE html><html><head><title>Just a moment...</title></head>'
    + '<body>Checking your browser</body></html>'
