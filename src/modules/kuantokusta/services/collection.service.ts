import { setTimeout as sleep } from 'node:timers/promises'

import { Injectable, Logger } from '@nestjs/common'

import { PrismaService } from '#/infra/database/prisma.service'
import { CredentialDecryptionError } from '#/modules/credentials/domain/credential-cipher'

import { comparePrices } from '../domain/comparison'
import type { StoreIdentity } from '../domain/comparison'
import { PARSER_VERSION } from '../domain/page-offers'
import type { PageOffer } from '../domain/page-offers'
import type { PageOutcome, PageReading } from '../domain/page-reading'
import { guessStoreIdentity, learnSellerId } from '../domain/store-identity'
import {
  CollectionRunsService,
  MAX_ATTEMPTS
} from './collection-runs.service'
import type { Claim, RunProgress } from './collection-runs.service'
import {
  InvalidKkSettingsError,
  KkIdentityTakenError,
  KkStoreSettingsService,
  MAX_SELLER_ID
} from './kk-store-settings.service'
import {
  KkCredentialMissingError,
  OffersSyncService
} from './offers-sync.service'
import { ProductPageClient } from './product-page.client'
import {
  KkKeyRejectedError,
  KkRateLimitedError,
  KkUnavailableError,
  KkUnexpectedResponseError
} from './seller-api.client'

/**
 * Carries out one collection run for one store:
 *
 *   1. refresh the store's own offers from the Seller API;
 *   2. make sure there is a recent reading of each offer's product page,
 *      going to the website only for the pages that have none;
 *   3. compare the store's price with the other stores on each page.
 *
 * Step 2 is the slow and fragile one: one page every few seconds, on a site
 * that may refuse at any time. Each reading is stored as soon as it is made,
 * so a run that is interrupted picks up where it stopped.
 */
export interface CollectionControl {
  /** True once the service was asked to stop. Checked between pages. */
  readonly stopRequested: boolean
  /** Aborted at the same moment, to cut a pause short. */
  readonly signal: AbortSignal
}

export interface CollectionTimings {
  /** Pause between two pages read from the website. */
  pageIntervalMs: number
  /** A stored reading newer than this is used instead of reading again. */
  reuseReadingsForMs: number
  /**
   * After the website refused the hub, no store's collection goes back to it
   * for this long.
   */
  blockCooldownMs: number
  /** A collection still reading pages after this long is stopped. */
  maxRunMs: number
}

export const DEFAULT_TIMINGS: CollectionTimings = {
  pageIntervalMs: 5_000,
  reuseReadingsForMs: 2 * 60 * 60_000,
  blockCooldownMs: 30 * 60_000,
  // At one page every five seconds this is some four thousand pages.
  maxRunMs: 6 * 60 * 60_000
}

/**
 * `lost`: the run stopped being this worker's while it worked (see Claim).
 * Nothing more was written for it.
 * `crashed`: something unexpected went wrong. The run is left as it is, to
 * be taken up again as an abandoned one.
 */
export type CollectionEnd = 'finished' | 'requeued' | 'lost' | 'crashed'

/** Why the reading of pages stopped before the last page. */
type StopReason
  = | 'blocked_by_site'
    | 'robots_refused'
    | 'robots_unavailable'
    | 'crawl_delay_too_long'
    | 'page_layout_changed'
    | 'site_unavailable'
    | 'run_too_long'

/** The reasons that mean "the website said no", as opposed to "it failed". */
const REFUSALS: readonly StopReason[] = ['blocked_by_site', 'robots_refused']

type ReadingPhase
  = | { interrupted: 'requeued' | 'lost' }
    | { interrupted: null, stoppedBy: StopReason | null }

// Insisting after this many refusals in a row only makes things worse for
// the address the hub runs from, and brings no data.
const MAX_CONSECUTIVE_BLOCKS = 3
// This many pages in a row that came back unusable, without being refused,
// mean the problem is not the page: the site changed its pages or is down.
// Reading on would be hundreds of requests for nothing.
const MAX_CONSECUTIVE_UNREADABLE = 10
// A site asking for a longer pause than this between pages is, in effect,
// asking not to be read. The run stops instead of taking a day.
const MAX_CRAWL_DELAY_SECONDS = 120
// Readings with these outcomes say something about the page itself and can
// be reused. The others (blocked, errors) say something about the attempt.
const REUSABLE: readonly PageOutcome[] = ['ok', 'not_found', 'no_offer_list']

const WORKER = { type: 'system', label: 'collection-worker' } as const

interface Target {
  offerId: bigint
  productId: bigint
  productUrl: string
  apiPriceCents: number
}

/** What is known about a target's page once the reading phase is over. */
interface Reading {
  snapshotId: bigint | null
  outcome: PageOutcome | 'disallowed'
  offers: PageOffer[] | null
}

@Injectable()
export class CollectionService {
  private readonly logger = new Logger(CollectionService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: CollectionRunsService,
    private readonly offersSync: OffersSyncService,
    private readonly settings: KkStoreSettingsService,
    private readonly pages: ProductPageClient,
    private readonly timings: CollectionTimings
  ) {}

  /**
   * Runs a collection that the caller has already marked as running, and
   * leaves it finished, back in the queue, or (after a crash) as it was, to
   * be taken up again as an abandoned one.
   */
  async execute(
    claim: Claim,
    control: CollectionControl
  ): Promise<CollectionEnd> {
    const { storeId, runId } = claim
    this.logger.log(
      `Collection started store=${storeId} run=${runId} `
      + `attempt=${claim.attempt}`
    )
    try {
      return await this.run(claim, control)
    } catch (error) {
      this.logger.error(
        `Collection crashed store=${storeId} run=${runId} `
        + `attempt=${claim.attempt}`,
        error instanceof Error ? error.stack : String(error)
      )
      // Most often the cause passes by itself (the database was away for a
      // moment). So the run is left alone: with no more signs of life it is
      // taken up again in a few minutes, and the pages already read are
      // reused. Only the last attempt records the failure.
      if (claim.attempt < MAX_ATTEMPTS) return 'crashed'
      await this.runs.finish(claim, {
        status: 'failed',
        errorCode: 'internal_error'
      })
      return 'finished'
    }
  }

  private async run(
    claim: Claim,
    control: CollectionControl
  ): Promise<CollectionEnd> {
    const { storeId, runId } = claim

    // 1. The store's own offers, fresh from the Seller API.
    const syncFailure = await this.refreshOffers(storeId)
    if (syncFailure) {
      await this.runs.finish(claim, {
        status: 'failed',
        errorCode: syncFailure
      })
      return 'finished'
    }

    // 2. A reading of each product page.
    const targets = await this.targets(storeId)
    if (targets.length === 0) {
      // Nothing listed and in stock: nothing to compare, and not a failure.
      await this.runs.finish(claim, {
        status: 'succeeded',
        progress: { total: 0, ok: 0, failed: 0 }
      })
      return 'finished'
    }
    const readings = await this.reusableReadings(targets)
    const progress = (): RunProgress => countProgress(targets, readings)
    if (!(await this.runs.heartbeat(claim, progress()))) return this.lost(claim)

    const missing = targets.filter((target) => !readings.has(target.offerId))
    const phase: ReadingPhase = missing.length === 0
      ? { interrupted: null, stoppedBy: null }
      : await this.readPages(claim, control, missing, readings, progress)
    if (phase.interrupted !== null) {
      if (phase.interrupted === 'lost') return this.lost(claim)
      await this.runs.requeue(claim)
      return 'requeued'
    }
    const { stoppedBy } = phase

    // 3. The comparisons, from whatever was read.
    if (!(await this.runs.heartbeat(claim, progress()))) return this.lost(claim)
    const identity = await this.resolveIdentity(storeId, targets, readings)
    if (identity.kind === 'known') {
      await this.storeComparisons(storeId, runId, targets, readings, identity.store)
    }

    const final = progress()
    if (stoppedBy) {
      await this.runs.finish(claim, {
        status: REFUSALS.includes(stoppedBy) ? 'blocked' : 'failed',
        errorCode: stoppedBy,
        progress: final
      })
    } else if (final.ok === 0) {
      // Every page was looked at and not one could be used.
      await this.runs.finish(claim, {
        status: 'failed',
        errorCode: 'no_page_read',
        progress: final
      })
    } else if (identity.kind !== 'known') {
      await this.runs.finish(claim, {
        status: 'failed',
        errorCode: identity.errorCode,
        progress: final
      })
    } else {
      await this.runs.finish(claim, {
        status: final.failed > 0 ? 'partial' : 'succeeded',
        progress: final
      })
    }
    return 'finished'
  }

  /**
   * Goes to the website for the pages that have no recent reading, one at a
   * time, storing each reading as it is made.
   */
  private async readPages(
    claim: Claim,
    control: CollectionControl,
    missing: readonly Target[],
    readings: Map<bigint, Reading>,
    progress: () => RunProgress
  ): Promise<ReadingPhase> {
    const stopped = (stoppedBy: StopReason | null): ReadingPhase => ({
      interrupted: null,
      stoppedBy
    })

    // Refused a moment ago, in this run or in another store's: not again yet.
    if (await this.refusedRecently()) return stopped('blocked_by_site')

    const robots = await this.pages.fetchRobots()
    if (robots.kind === 'blocked') return stopped('robots_refused')
    if (robots.kind === 'unavailable') {
      this.logger.warn(`robots.txt unavailable: ${robots.reason}`)
      return stopped('robots_unavailable')
    }
    const crawlDelay = this.pages.crawlDelaySeconds(robots.groups)
    if (crawlDelay > MAX_CRAWL_DELAY_SECONDS) {
      return stopped('crawl_delay_too_long')
    }

    const pauseMs = Math.max(this.timings.pageIntervalMs, crawlDelay * 1000)
    const deadline = Date.now() + this.timings.maxRunMs
    let consecutiveBlocks = 0
    let unreadable = { inARow: 0, layout: 0 }
    let firstRequest = true
    let disallowed = 0

    for (const target of missing) {
      if (control.stopRequested) return { interrupted: 'requeued' }
      if (Date.now() > deadline) return stopped('run_too_long')

      if (!this.pages.isAllowed(robots.groups, target.productUrl)) {
        readings.set(target.offerId, {
          snapshotId: null,
          outcome: 'disallowed',
          offers: null
        })
        disallowed++
        continue
      }

      if (!firstRequest && !(await this.pause(pauseMs, control))) {
        return { interrupted: 'requeued' }
      }
      firstRequest = false

      const reading = await this.pages.fetchPage(target.productUrl)
      const snapshotId = await this.storeReading(target, reading)
      readings.set(target.offerId, { ...reading, snapshotId })
      if (!(await this.runs.heartbeat(claim, progress()))) {
        return { interrupted: 'lost' }
      }

      const { outcome } = reading
      consecutiveBlocks = outcome === 'blocked' ? consecutiveBlocks + 1 : 0
      if (consecutiveBlocks >= MAX_CONSECUTIVE_BLOCKS) {
        return stopped('blocked_by_site')
      }

      // `ok` and `not_found` are answers about the page. Anything else is
      // a page the hub could not use.
      unreadable = outcome === 'ok' || outcome === 'not_found'
        ? { inARow: 0, layout: 0 }
        : {
            inARow: unreadable.inARow + 1,
            layout: unreadable.layout + (outcome === 'no_offer_list' ? 1 : 0)
          }
      if (unreadable.inARow >= MAX_CONSECUTIVE_UNREADABLE) {
        return stopped(
          unreadable.layout === unreadable.inARow
            ? 'page_layout_changed'
            : 'site_unavailable'
        )
      }
    }

    // robots.txt lets this client read none of the pages: that is the site
    // saying no, not a page-by-page problem.
    return stopped(disallowed === missing.length ? 'robots_refused' : null)
  }

  /**
   * Whether the last pages read by the hub, for any store, were all refused,
   * and recently. The readings are shared by every store, and so is the
   * website's patience: one store's collection being refused keeps the
   * others away too.
   */
  private async refusedRecently(): Promise<boolean> {
    const latest = await this.prisma.kk_page_snapshots.findMany({
      orderBy: { id: 'desc' },
      take: MAX_CONSECUTIVE_BLOCKS,
      select: { outcome: true, fetched_at: true }
    })
    return (
      latest.length === MAX_CONSECUTIVE_BLOCKS
      && latest.every((snapshot) => snapshot.outcome === 'blocked')
      && Date.now() - latest[0].fetched_at.getTime() < this.timings.blockCooldownMs
    )
  }

  private lost(claim: Claim): CollectionEnd {
    this.logger.warn(
      `Collection no longer held, stopping store=${claim.storeId} `
      + `run=${claim.runId} attempt=${claim.attempt}`
    )
    return 'lost'
  }

  /** Returns the reason the offers could not be refreshed, or null. */
  private async refreshOffers(storeId: string): Promise<string | null> {
    try {
      await this.offersSync.sync(storeId, WORKER)
      return null
    } catch (error) {
      if (error instanceof KkCredentialMissingError) return 'kk_key_missing'
      if (error instanceof KkKeyRejectedError) return 'kk_key_rejected'
      if (error instanceof KkRateLimitedError) return 'kk_rate_limited'
      if (error instanceof KkUnavailableError) return 'kk_unavailable'
      if (error instanceof KkUnexpectedResponseError) {
        return 'kk_unexpected_response'
      }
      if (error instanceof CredentialDecryptionError) {
        return 'credential_unreadable'
      }
      throw error
    }
  }

  /** The offers worth comparing: listed on KuantoKusta and in stock. */
  private async targets(storeId: string): Promise<Target[]> {
    // Bounded by the size of one store's catalogue on KuantoKusta.
    const offers = await this.prisma.withStore(storeId, (tx) =>
      tx.kk_store_offers.findMany({
        where: { listing_status: 'listed', stock: { gt: 0 } },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          price_cents: true,
          kk_products: { select: { id: true, url: true } }
        }
      })
    )
    return offers.map((offer) => ({
      offerId: offer.id,
      productId: offer.kk_products.id,
      productUrl: offer.kk_products.url,
      apiPriceCents: offer.price_cents
    }))
  }

  /**
   * Recent readings that can stand in for a new one: from an earlier part of
   * this run before an interruption, from a run a moment ago, or from
   * another store that sells the same product.
   */
  private async reusableReadings(
    targets: readonly Target[]
  ): Promise<Map<bigint, Reading>> {
    const readings = new Map<bigint, Reading>()
    if (targets.length === 0) return readings

    const snapshots = await this.prisma.kk_page_snapshots.findMany({
      where: {
        product_id: { in: targets.map((target) => target.productId) },
        fetched_at: {
          gt: new Date(Date.now() - this.timings.reuseReadingsForMs)
        },
        outcome: { in: [...REUSABLE] },
        // Read by this version of the parser: after a fix to the parser,
        // what the old one made of a page is not trusted.
        parser_version: PARSER_VERSION
      },
      orderBy: { fetched_at: 'desc' },
      select: { id: true, product_id: true, outcome: true, offers: true }
    })
    // Newest first, so the first one seen for a product is the one to keep.
    const newest = new Map<bigint, (typeof snapshots)[number]>()
    for (const snapshot of snapshots) {
      if (!newest.has(snapshot.product_id)) {
        newest.set(snapshot.product_id, snapshot)
      }
    }

    for (const target of targets) {
      const snapshot = newest.get(target.productId)
      if (!snapshot) continue
      readings.set(target.offerId, {
        snapshotId: snapshot.id,
        outcome: snapshot.outcome as PageOutcome,
        offers: snapshot.outcome === 'ok'
          ? (snapshot.offers as unknown as PageOffer[])
          : null
      })
    }
    return readings
  }

  private async storeReading(
    target: Target,
    reading: PageReading
  ): Promise<bigint> {
    const snapshot = await this.prisma.kk_page_snapshots.create({
      data: {
        product_id: target.productId,
        outcome: reading.outcome,
        http_status: reading.httpStatus,
        ...(reading.offers === null
          ? {}
          : { offers: reading.offers as unknown as object[] }),
        parser_version: PARSER_VERSION
      },
      select: { id: true }
    })
    return snapshot.id
  }

  /**
   * How the store appears on the pages: as already recorded, or worked out
   * now from the pages just read and recorded for next time.
   */
  private async resolveIdentity(
    storeId: string,
    targets: readonly Target[],
    readings: ReadonlyMap<bigint, Reading>
  ): Promise<
    | { kind: 'known', store: StoreIdentity }
    | { kind: 'unknown', errorCode: string }
  > {
    const readable = targets.flatMap((target) => {
      const offers = readings.get(target.offerId)?.offers
      return offers ? [{ apiPriceCents: target.apiPriceCents, offers }] : []
    })

    const stored = await this.settings.get(storeId)
    if (stored) {
      const { identity } = stored
      if (identity.sellerId !== null) return { kind: 'known', store: identity }

      // The slug is known; the seller id, a steadier key, may be on the pages.
      const sellerId = usableSellerId(
        learnSellerId(
          identity.storeSlug,
          readable.map((page) => page.offers)
        )
      )
      if (sellerId === null) return { kind: 'known', store: identity }
      return this.recordIdentity(storeId, { ...identity, sellerId }, identity)
    }

    const guess = guessStoreIdentity(readable)
    if (guess.kind === 'unknown') {
      this.logger.warn(
        `Could not tell which store is the hub's store=${storeId} `
        + `reason=${guess.reason} pages=${guess.pages}`
      )
      return { kind: 'unknown', errorCode: 'store_identity_unknown' }
    }
    this.logger.log(
      `Recognised the store on KuantoKusta store=${storeId} `
      // Text from a third-party page: quoted, so it cannot forge a log line.
      + `slug=${JSON.stringify(guess.storeSlug)} seller=${guess.sellerId ?? '-'} `
      + `matches=${guess.matches}/${guess.pages}`
    )
    return this.recordIdentity(
      storeId,
      { storeSlug: guess.storeSlug, sellerId: usableSellerId(guess.sellerId) },
      null
    )
  }

  private async recordIdentity(
    storeId: string,
    identity: StoreIdentity,
    fallback: StoreIdentity | null
  ): Promise<
    | { kind: 'known', store: StoreIdentity }
    | { kind: 'unknown', errorCode: string }
  > {
    try {
      await this.settings.setIdentity(storeId, identity)
      return { kind: 'known', store: identity }
    } catch (error) {
      if (error instanceof InvalidKkSettingsError) {
        // The pages carry a slug or a seller id the hub does not accept as
        // one. Third-party data: reported, never stored as it came.
        this.logger.warn(
          `KuantoKusta identity not usable store=${storeId}: ${error.message}`
        )
        return fallback
          ? { kind: 'known', store: fallback }
          : { kind: 'unknown', errorCode: 'store_identity_unknown' }
      }
      if (!(error instanceof KkIdentityTakenError)) throw error
      this.logger.warn(
        `KuantoKusta identity already used by another store store=${storeId}`
      )
      // Reported like any other "not recognised": the caller is not told
      // that the name belongs to another store of the hub.
      return fallback
        ? { kind: 'known', store: fallback }
        : { kind: 'unknown', errorCode: 'store_identity_unknown' }
    }
  }

  private async storeComparisons(
    storeId: string,
    runId: string,
    targets: readonly Target[],
    readings: ReadonlyMap<bigint, Reading>,
    store: StoreIdentity
  ): Promise<void> {
    const rows = targets.flatMap((target) => {
      const reading = readings.get(target.offerId)
      // Not reached before the run stopped: nothing is known, nothing said.
      if (!reading) return []

      const base = {
        store_id: storeId,
        run_id: runId,
        store_offer_id: target.offerId,
        snapshot_id: reading.snapshotId
      }
      if (!reading.offers) {
        // The page could not be read. The store's price is still recorded.
        return [
          {
            ...base,
            outcome: 'no_data',
            store_price_cents: target.apiPriceCents
          }
        ]
      }

      const result = comparePrices({
        apiPriceCents: target.apiPriceCents,
        offers: reading.offers,
        store
      })
      return [
        {
          ...base,
          outcome: result.outcome,
          store_price_cents: result.storePriceCents,
          store_is_listed: result.storeIsListed,
          lowest_price_cents: result.lowestPriceCents,
          lowest_store_name: result.lowestStoreName,
          lowest_store_slug: result.lowestStoreSlug,
          difference_cents: result.differenceCents,
          store_position: result.storePosition,
          store_count: result.storeCount,
          store_total_cents: result.storeTotalCents,
          lowest_total_cents: result.lowestTotalCents,
          lowest_total_store_name: result.lowestTotalStoreName
        }
      ]
    })
    if (rows.length === 0) return

    // One row per offer and run: a run taken up again does not duplicate.
    await this.prisma.withStore(
      storeId,
      (tx) =>
        tx.kk_price_comparisons.createMany({ data: rows, skipDuplicates: true }),
      { timeoutMs: 30_000 }
    )
  }

  /**
   * Waits between two pages, a little more or less each time so the requests
   * do not tick like a clock. Returns false if the wait was cut short
   * because the service is stopping.
   */
  private async pause(ms: number, control: CollectionControl): Promise<boolean> {
    if (ms <= 0) return !control.stopRequested
    const jittered = ms * (0.8 + Math.random() * 0.4)
    try {
      await sleep(jittered, undefined, { signal: control.signal })
      return true
    } catch {
      return false
    }
  }
}

/** A seller id read from a page, if it is one the hub can keep. */
function usableSellerId(sellerId: number | null): number | null {
  return sellerId !== null && sellerId > 0 && sellerId <= MAX_SELLER_ID
    ? sellerId
    : null
}

function countProgress(
  targets: readonly Target[],
  readings: ReadonlyMap<bigint, Reading>
): RunProgress {
  let ok = 0
  let failed = 0
  for (const target of targets) {
    const reading = readings.get(target.offerId)
    if (!reading) continue
    if (reading.outcome === 'ok') ok++
    else failed++
  }
  return { total: targets.length, ok, failed }
}
