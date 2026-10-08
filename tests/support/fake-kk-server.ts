import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A stand-in for the KuantoKusta Seller API, listening on 127.0.0.1.
 *
 * It behaves like the real one where the client depends on it: the key in
 * `x-api-key`, pages of a bare array, 401 for a wrong key, 429 with
 * `Retry-After`. Tests switch on the misbehaviours they want to see handled.
 */
export interface RecordedRequest {
  method: string
  path: string
  apiKey: string | undefined
}

export class FakeKkServer {
  /** The key this server accepts. */
  acceptedKey = 'kk-test-key-0001'
  /** What `GET /v2/kms/offers` returns, before paging. */
  offers: unknown[] = []
  /** Every request received, in order. */
  requests: RecordedRequest[] = []
  /** Answers queued here are sent first, one per request. */
  queued: ((response: ServerResponse) => void)[] = []
  /** When true, the `page` parameter is ignored, as a broken API would. */
  ignorePaging = false

  private server: Server | undefined

  get url(): string {
    const { port } = this.server?.address() as AddressInfo
    return `http://127.0.0.1:${port}/api`
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
    this.acceptedKey = 'kk-test-key-0001'
    this.offers = []
    this.requests = []
    this.queued = []
    this.ignorePaging = false
  }

  /** Queues `times` answers with that status and an empty JSON body. */
  failNext(times: number, status: number, headers = {}): void {
    for (let i = 0; i < times; i++) {
      this.queued.push((response) => {
        response.writeHead(status, {
          'content-type': 'application/json',
          ...headers
        })
        response.end('{"error":{"code":"KMS0000"}}')
      })
    }
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? '/', 'http://fake')
    const apiKey = request.headers['x-api-key']
    this.requests.push({
      method: request.method ?? '',
      path: url.pathname + url.search,
      apiKey: typeof apiKey === 'string' ? apiKey : undefined
    })

    const queued = this.queued.shift()
    if (queued) return queued(response)

    if (request.method !== 'GET' || url.pathname !== '/api/v2/kms/offers') {
      response.writeHead(404).end()
      return
    }
    if (apiKey !== this.acceptedKey) {
      response.writeHead(401, { 'content-type': 'application/json' })
      // The real answer to a wrong key, observed on 2026-10-08.
      response.end('{"error":{"code":"KMS0000"}}')
      return
    }

    const page = this.ignorePaging
      ? 1
      : Number(url.searchParams.get('page') ?? '1')
    const size = Number(url.searchParams.get('maxResultsPerPage') ?? '100')
    const items = this.offers.slice((page - 1) * size, page * size)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(items))
  }
}

/**
 * An offer shaped like the real response (docs/kuantokusta.md), with
 * invented values. `n` makes each one distinct.
 */
export function fakeOffer(n: number, overrides: Record<string, unknown> = {}) {
  return {
    productId: `p-9-${30000 + n}`,
    brandName: 'Marca',
    categoryName: 'Categoria',
    productName: `Produto de teste ${n}`,
    productNameKK: `Produto de teste ${n} (KK)`,
    url: `https://loja.example/produto/teste-${n}/`,
    cpc: 0.12,
    sellerProductId: null,
    ean: `56000000${String(n).padStart(5, '0')}`,
    sku: String(6800000 + n),
    importAuto: true,
    isBlacklisted: false,
    isTopBox: false,
    price: 9.34 + n,
    oldPrice: 0,
    stock: 13,
    image: 'https://img.example/x.jpg',
    productUrl: `https://www.kuantokusta.pt/p/${3400000 + n}/produto-de-teste-${n}`,
    shipping: { normal: { delivery: { min: 2, max: 4 } } },
    updatedAt: '2026-10-08 00:49:45',
    categoryId: 1337,
    commission: 0.05,
    ...overrides
  }
}
