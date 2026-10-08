import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import { Logger } from '@nestjs/common'

import { SlidingWindowLimiter } from '../domain/sliding-window-limiter'
import type { RateWindow } from '../domain/sliding-window-limiter'

/**
 * Client of the KuantoKusta Seller API.
 *
 * READ ONLY. The same API, with the same key, changes prices and stock and
 * approves or cancels orders. This client can only send GET requests to the
 * offers list, and adding anything else is a separate decision
 * (docs/security.md, "Limits of this design").
 *
 * The API key is a parameter of each call and is never kept, logged or put
 * in an error.
 */

/** The key was refused (401 or 403). Retrying with the same key is useless. */
export class KkKeyRejectedError extends Error {
  constructor() {
    super('KuantoKusta refused the API key')
    this.name = 'KkKeyRejectedError'
  }
}

/** Still rate-limited after waiting as long as the API asked. */
export class KkRateLimitedError extends Error {
  constructor() {
    super('KuantoKusta is rate-limiting this key')
    this.name = 'KkRateLimitedError'
  }
}

/** The API did not answer, or answered with a server error, after retries. */
export class KkUnavailableError extends Error {
  constructor(reason: string) {
    super(`KuantoKusta could not be reached: ${reason}`)
    this.name = 'KkUnavailableError'
  }
}

/** The API answered something this client does not understand. */
export class KkUnexpectedResponseError extends Error {
  constructor(reason: string) {
    super(`Unexpected answer from KuantoKusta: ${reason}`)
    this.name = 'KkUnexpectedResponseError'
  }
}

export interface KkSellerApiOptions {
  /** For example https://seller.kuantokusta.pt/api */
  baseUrl: string
  timeoutMs?: number
  /** Attempts per page, the first one included. */
  maxAttempts?: number
  /** The longest this client waits when told to slow down. */
  maxRetryAfterMs?: number
  /** The longest a whole list may take to read, waits included. */
  deadlineMs?: number
  rateWindows?: readonly RateWindow[]
  /** Replaced in tests, so they do not really wait. */
  sleep?: (ms: number) => Promise<unknown>
}

const USER_AGENT = 'PharmaHub/0.1 (price report; KuantoKusta Seller API)'
const PAGE_SIZE = 100
// 30,000 offers. A guard against a pagination that never ends, not a limit
// anyone is expected to reach.
const MAX_PAGES = 300
const MAX_BODY_BYTES = 5 * 1024 * 1024
// For the whole list, so that many large pages cannot add up to all the
// memory the process has.
const MAX_TOTAL_BYTES = 50 * 1024 * 1024
// Keys tried and refused would otherwise leave a limiter behind forever.
const MAX_LIMITERS = 500

// One below each published limit (5/s, 20/10 s, 30/60 s), as a margin for
// clocks that do not agree.
const DEFAULT_WINDOWS: readonly RateWindow[] = [
  { limit: 4, periodMs: 1_000 },
  { limit: 19, periodMs: 10_000 },
  { limit: 29, periodMs: 60_000 }
]

export class KkSellerApiClient {
  private readonly logger = new Logger(KkSellerApiClient.name)
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly maxAttempts: number
  private readonly maxRetryAfterMs: number
  private readonly deadlineMs: number
  private readonly rateWindows: readonly RateWindow[]
  private readonly sleep: (ms: number) => Promise<unknown>
  // One limiter per key, found by a hash so the key itself is not held here.
  private readonly limiters = new Map<string, SlidingWindowLimiter>()

  constructor(options: KkSellerApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.maxAttempts = options.maxAttempts ?? 3
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 60_000
    this.deadlineMs = options.deadlineMs ?? 15 * 60_000
    this.rateWindows = options.rateWindows ?? DEFAULT_WINDOWS
    this.sleep = options.sleep ?? sleep
  }

  /**
   * Confirms that the API accepts the key, by reading a single offer.
   * Resolves when it does; throws one of the errors above when it does not.
   *
   * One attempt, no retries: the caller is a person or a plugin waiting for
   * an answer, and each try is a request made with a key someone chose.
   */
  async verifyKey(apiKey: string): Promise<void> {
    await this.getOffersPage(apiKey, 1, 1, { attempts: 1, label: 'verify' })
  }

  /**
   * Every offer of the store that owns the key, as raw items.
   *
   * The response has no total: pages are read until one comes back short.
   * Either all pages are read or this throws; it never returns part of the
   * list, because a partial list would look like offers that were removed.
   */
  async fetchAllOffers(
    apiKey: string,
    /** Goes into the log lines, to tell one store's calls from another's. */
    label = '-'
  ): Promise<unknown[]> {
    const offers: unknown[] = []
    const budget = { bytesLeft: MAX_TOTAL_BYTES }
    const deadline = Date.now() + this.deadlineMs
    let previousFirst: string | undefined

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (Date.now() > deadline) {
        throw new KkUnavailableError(
          `the list was not complete after ${this.deadlineMs / 60_000} minutes`
        )
      }
      const items = await this.getOffersPage(apiKey, page, PAGE_SIZE, {
        attempts: this.maxAttempts,
        label,
        budget
      })

      // If the API ignored `page`, every page would be the first one.
      const first = items.length > 0 ? JSON.stringify(items[0]) : undefined
      if (page > 1 && first !== undefined && first === previousFirst) {
        throw new KkUnexpectedResponseError('the same page came back twice')
      }
      previousFirst = first

      offers.push(...items)
      if (items.length < PAGE_SIZE) return offers
    }

    throw new KkUnexpectedResponseError(`more than ${MAX_PAGES} pages`)
  }

  private async getOffersPage(
    apiKey: string,
    page: number,
    pageSize: number,
    call: { attempts: number, label: string, budget?: { bytesLeft: number } }
  ): Promise<unknown[]> {
    const url
      = `${this.baseUrl}/v2/kms/offers`
        + `?page=${page}&maxResultsPerPage=${pageSize}`
    const maxAttempts = call.attempts
    let lastFailure = 'no attempt was made'

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.waitForRateLimit(apiKey)

      const startedAt = Date.now()
      let response: Response
      try {
        response = await fetch(url, {
          method: 'GET',
          headers: {
            'x-api-key': apiKey,
            'accept': 'application/json',
            'user-agent': USER_AGENT
          },
          // The key must never follow a redirect to another address.
          redirect: 'error',
          signal: AbortSignal.timeout(this.timeoutMs)
        })
      } catch (error) {
        lastFailure = describeNetworkError(error)
        this.log(call.label, page, lastFailure, startedAt)
        await this.backOff(attempt, maxAttempts)
        continue
      }

      this.log(call.label, page, `status ${response.status}`, startedAt)

      if (response.status === 401 || response.status === 403) {
        // Only the API itself can say the key is wrong. A 403 page from a
        // firewall in front of it means the hub was blocked, and blaming
        // the key would send someone to fix the wrong thing.
        if (await isApiError(response)) throw new KkKeyRejectedError()
        throw new KkUnexpectedResponseError(
          `status ${response.status} that did not come from the API`
        )
      }

      if (response.status === 429) {
        await discard(response)
        if (attempt === maxAttempts) throw new KkRateLimitedError()
        // The API blocks the key for 30 seconds; waiting is the only way out.
        await this.sleep(this.retryAfterMs(response))
        continue
      }

      if (response.status >= 500) {
        await discard(response)
        lastFailure = `status ${response.status}`
        await this.backOff(attempt, maxAttempts)
        continue
      }

      if (response.status !== 200) {
        await discard(response)
        throw new KkUnexpectedResponseError(`status ${response.status}`)
      }

      let body: string
      try {
        body = await readBody(response)
        if (call.budget) {
          call.budget.bytesLeft -= Buffer.byteLength(body)
          if (call.budget.bytesLeft < 0) {
            throw new KkUnexpectedResponseError('the whole list is too large')
          }
        }
      } catch (error) {
        if (error instanceof KkUnexpectedResponseError) throw error
        // The connection dropped, or timed out, while the body was arriving.
        lastFailure = describeNetworkError(error)
        await this.backOff(attempt, maxAttempts)
        continue
      }
      return readOfferList(body)
    }

    throw new KkUnavailableError(lastFailure)
  }

  private async waitForRateLimit(apiKey: string): Promise<void> {
    const id = createHash('sha256').update(apiKey).digest('hex')
    let limiter = this.limiters.get(id)
    if (!limiter) {
      limiter = new SlidingWindowLimiter(this.rateWindows)
      this.limiters.set(id, limiter)
      // A Map keeps insertion order, so the first key is the oldest.
      if (this.limiters.size > MAX_LIMITERS) {
        const [oldest] = this.limiters.keys()
        this.limiters.delete(oldest)
      }
    }

    for (let delay = limiter.delayMs(); delay > 0; delay = limiter.delayMs()) {
      await this.sleep(delay)
    }
    limiter.record()
  }

  /** Exponential backoff with jitter, skipped after the last attempt. */
  private async backOff(attempt: number, maxAttempts: number): Promise<void> {
    if (attempt >= maxAttempts) return
    const base = 500 * 2 ** (attempt - 1)
    await this.sleep(base + Math.random() * base)
  }

  private retryAfterMs(response: Response): number {
    const seconds = Number(response.headers.get('retry-after'))
    const asked = Number.isFinite(seconds) && seconds > 0 ? seconds : 30
    return Math.min((asked + 1) * 1000, this.maxRetryAfterMs)
  }

  private log(
    label: string,
    page: number,
    outcome: string,
    startedAt: number
  ): void {
    this.logger.log(
      `GET /v2/kms/offers page=${page} ${outcome} `
      + `ms=${Date.now() - startedAt} for=${label}`
    )
  }
}

/**
 * A short, safe description: the kind of failure, never the request.
 *
 * Read by shape rather than with `instanceof`: these errors are created
 * inside the runtime's networking code, not by this module.
 */
function describeNetworkError(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'network error'
  if ('name' in error && error.name === 'TimeoutError') return 'timeout'

  const cause: unknown = 'cause' in error ? error.cause : undefined
  // The API answered with a redirect, which this client refuses to follow.
  if (
    typeof cause === 'object'
    && cause !== null
    && 'message' in cause
    && cause.message === 'unexpected redirect'
  ) {
    return 'redirect refused'
  }
  if (
    typeof cause === 'object'
    && cause !== null
    && 'code' in cause
    && typeof cause.code === 'string'
    && /^[A-Z0-9_]{3,40}$/.test(cause.code)
  ) {
    return cause.code
  }
  return 'network error'
}

/**
 * Whether the body is the API's own error format, as observed:
 * `{"error":{"code":"KMS0000"}}`.
 */
async function isApiError(response: Response): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readBody(response))
    const error: unknown
      = typeof parsed === 'object' && parsed !== null && 'error' in parsed
        ? parsed.error
        : undefined
    return (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && typeof error.code === 'string'
      && error.code.startsWith('KMS')
    )
  } catch {
    return false
  }
}

/** Frees the connection without reading a body nobody will use. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Nothing to do: the response is being thrown away either way.
  }
}

/** Reads the body as text, refusing one larger than any real page. */
async function readBody(response: Response): Promise<string> {
  if (!response.body) return ''

  const chunks: Uint8Array[] = []
  let size = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES) {
      await reader.cancel()
      throw new KkUnexpectedResponseError('the response is too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function readOfferList(body: string): unknown[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new KkUnexpectedResponseError('the response is not JSON')
  }
  if (!Array.isArray(parsed)) {
    throw new KkUnexpectedResponseError('the response is not a list')
  }
  return parsed
}
