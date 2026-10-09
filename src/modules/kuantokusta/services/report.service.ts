import { Injectable } from '@nestjs/common'

import { Prisma } from '#/generated/prisma/client'
import { PrismaService } from '#/infra/database/prisma.service'

import {
  CHECK_LINK_PERCENT,
  differencePercent,
  isEasyAdjust,
  needsLinkCheck
} from '../domain/comparison'
import type { ComparisonOutcome } from '../domain/comparison'
import { CollectionRunsService } from './collection-runs.service'
import type { RunView } from './collection-runs.service'
import {
  DEFAULT_EASY_ADJUST_CENTS,
  KkStoreSettingsService
} from './kk-store-settings.service'

/**
 * The price report: the latest comparison of each of the store's offers.
 *
 * "Latest" is per offer, not per collection (decision 0027): a collection
 * that was blocked halfway leaves the offers it did not reach with their
 * previous comparison, marked `stale`, instead of dropping them from the
 * report. Percentage, "easy adjust" and "check the link" are worked out
 * here, on every read, and never stored.
 */
export type ReportOutcome = ComparisonOutcome | 'no_data'

/**
 * Where the offer stands today, according to the latest copy of the store's
 * offers. Only `active` offers are compared by a collection (decision 0028).
 */
export type OfferState = 'active' | 'out_of_stock' | 'delisted'

export interface ReportRow {
  offerId: string
  offerRef: string
  sku: string | null
  ean: string | null
  name: string
  storeUrl: string
  productUrl: string
  offerState: OfferState
  runId: string
  comparedAt: Date
  /** Older than the store's most recent collection that ended. */
  stale: boolean
  outcome: ReportOutcome
  storePriceCents: number
  /** Null when the page could not be read. */
  storeIsListed: boolean | null
  lowestPriceCents: number | null
  lowestStoreName: string | null
  differenceCents: number | null
  differencePercent: number | null
  easyAdjust: boolean
  checkLink: boolean
  storePosition: number | null
  storeCount: number | null
  storeTotalCents: number | null
  lowestTotalCents: number | null
  lowestTotalStoreName: string | null
  /** storeTotalCents - lowestTotalCents, when the page showed both. */
  totalDifferenceCents: number | null
}

export interface ReportSummary {
  /** Offers in the report, before the outcome and flag filters. */
  offers: number
  cheapest: number
  tied: number
  more_expensive: number
  only_store: number
  no_data: number
  easyAdjust: number
  checkLink: number
  stale: number
}

export interface Report {
  /** The most recent collection that ended. Null when there was none. */
  run: RunView | null
  easyAdjustCents: number
  checkLinkPercent: number
  summary: ReportSummary
  rows: ReportRow[]
  nextCursor: string | null
}

export interface ReportQuery {
  limit: number
  /** The `nextCursor` of the previous page: the id of an offer. */
  after?: bigint
  state: OfferState | 'all'
  outcome?: ReportOutcome
  easyAdjust?: boolean
  checkLink?: boolean
}

export interface HistoryEntry {
  id: string
  runId: string
  comparedAt: Date
  outcome: ReportOutcome
  storePriceCents: number
  lowestPriceCents: number | null
  lowestStoreName: string | null
  differenceCents: number | null
  differencePercent: number | null
  storePosition: number | null
  storeCount: number | null
  storeTotalCents: number | null
  lowestTotalCents: number | null
}

export interface History {
  entries: HistoryEntry[]
  nextCursor: string | null
}

export interface HistoryQuery {
  limit: number
  /** The `nextCursor` of the previous page: the id of a comparison. */
  before?: bigint
}

interface ReportDbRow {
  offer_id: bigint
  kk_offer_ref: string
  sku: string | null
  ean: string | null
  name: string
  store_url: string
  product_url: string
  listing_status: string
  stock: number
  run_id: string
  compared_at: Date
  outcome: string
  store_price_cents: number
  store_is_listed: boolean | null
  lowest_price_cents: number | null
  lowest_store_name: string | null
  difference_cents: number | null
  store_position: number | null
  store_count: number | null
  store_total_cents: number | null
  lowest_total_cents: number | null
  lowest_total_store_name: string | null
}

type SummaryDbRow = { [K in keyof ReportSummary]: number }

@Injectable()
export class ReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: CollectionRunsService,
    private readonly settings: KkStoreSettingsService
  ) {}

  async report(storeId: string, query: ReportQuery): Promise<Report> {
    const [run, settings] = await Promise.all([
      this.runs.latestFinished(storeId),
      this.settings.get(storeId)
    ])
    const easyAdjustCents = settings?.easyAdjustCents ?? DEFAULT_EASY_ADJUST_CENTS
    const easy = Prisma.sql`coalesce(c.difference_cents > 0
      AND c.difference_cents <= ${easyAdjustCents}, false)`
    // The same rule as needsLinkCheck, in whole numbers.
    const checkLink = Prisma.sql`coalesce(c.difference_cents <> 0
      AND abs(c.difference_cents) * 100
          >= ${CHECK_LINK_PERCENT} * greatest(c.store_price_cents, c.lowest_price_cents), false)`
    // Not made by the most recent collection that ended. Comparisons are
    // written when a collection ends, so one running now has none yet.
    const stale = run?.finishedAt
      ? Prisma.sql`(c.run_id <> ${run.id}::uuid AND c.compared_at < ${run.finishedAt})`
      : Prisma.sql`false`

    const filters = [stateFilter(query.state)]
    if (query.after !== undefined) filters.push(Prisma.sql`o.id > ${query.after}`)
    if (query.outcome) filters.push(Prisma.sql`c.outcome = ${query.outcome}`)
    if (query.easyAdjust !== undefined) {
      filters.push(query.easyAdjust ? easy : Prisma.sql`NOT ${easy}`)
    }
    if (query.checkLink !== undefined) {
      filters.push(query.checkLink ? checkLink : Prisma.sql`NOT ${checkLink}`)
    }

    const { rows, summary } = await this.prisma.withStore(storeId, async (tx) => {
      const rows = await tx.$queryRaw<ReportDbRow[]>`
          SELECT o.id AS offer_id, o.kk_offer_ref, o.sku, o.ean, o.name,
                 o.store_url, p.url AS product_url, o.listing_status, o.stock,
                 c.run_id::text AS run_id, c.compared_at, c.outcome,
                 c.store_price_cents, c.store_is_listed, c.lowest_price_cents,
                 c.lowest_store_name, c.difference_cents,
                 c.store_position::int AS store_position,
                 c.store_count::int AS store_count,
                 c.store_total_cents, c.lowest_total_cents,
                 c.lowest_total_store_name
            FROM kk_store_offers o
            JOIN kk_products p ON p.id = o.product_id
            ${latestComparison}
           WHERE ${Prisma.join(filters, ' AND ')}
           ORDER BY o.id
           LIMIT ${query.limit + 1}`
      // Over the whole report, so the plugin can show the totals and the
      // filters next to one page of rows.
      const [summary] = await tx.$queryRaw<SummaryDbRow[]>`
          SELECT count(*)::int AS offers,
                 (count(*) FILTER (WHERE c.outcome = 'cheapest'))::int AS cheapest,
                 (count(*) FILTER (WHERE c.outcome = 'tied'))::int AS tied,
                 (count(*) FILTER (WHERE c.outcome = 'more_expensive'))::int AS more_expensive,
                 (count(*) FILTER (WHERE c.outcome = 'only_store'))::int AS only_store,
                 (count(*) FILTER (WHERE c.outcome = 'no_data'))::int AS no_data,
                 (count(*) FILTER (WHERE ${easy}))::int AS "easyAdjust",
                 (count(*) FILTER (WHERE ${checkLink}))::int AS "checkLink",
                 (count(*) FILTER (WHERE ${stale}))::int AS stale
            FROM kk_store_offers o
            ${latestComparison}
           WHERE ${stateFilter(query.state)}`
      return { rows, summary }
    })

    const page = rows.slice(0, query.limit)
    return {
      run,
      easyAdjustCents,
      checkLinkPercent: CHECK_LINK_PERCENT,
      summary,
      rows: page.map((row) => toReportRow(row, run, easyAdjustCents)),
      nextCursor: rows.length > query.limit
        ? page[page.length - 1].offer_id.toString()
        : null
    }
  }

  /**
   * Every comparison of one offer, newest first. Null when the store has no
   * such offer: another store's offer is simply not there.
   */
  async history(
    storeId: string,
    offerId: bigint,
    query: HistoryQuery
  ): Promise<History | null> {
    return this.prisma.withStore(storeId, async (tx) => {
      const offer = await tx.kk_store_offers.findUnique({
        where: { id: offerId },
        select: { id: true }
      })
      if (!offer) return null

      let where: Prisma.kk_price_comparisonsWhereInput = { store_offer_id: offerId }
      if (query.before !== undefined) {
        const cursor = await tx.kk_price_comparisons.findFirst({
          where: { id: query.before, store_offer_id: offerId },
          select: { id: true, compared_at: true }
        })
        if (!cursor) return { entries: [], nextCursor: null }
        where = {
          ...where,
          OR: [
            { compared_at: { lt: cursor.compared_at } },
            { compared_at: cursor.compared_at, id: { lt: cursor.id } }
          ]
        }
      }

      const rows = await tx.kk_price_comparisons.findMany({
        where,
        // Served by kk_price_comparisons_offer_compared_idx.
        orderBy: [{ compared_at: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        select: {
          id: true,
          run_id: true,
          compared_at: true,
          outcome: true,
          store_price_cents: true,
          lowest_price_cents: true,
          lowest_store_name: true,
          difference_cents: true,
          store_position: true,
          store_count: true,
          store_total_cents: true,
          lowest_total_cents: true
        }
      })
      const page = rows.slice(0, query.limit)
      return {
        entries: page.map((row) => {
          const comparison = {
            storePriceCents: row.store_price_cents,
            lowestPriceCents: row.lowest_price_cents,
            differenceCents: row.difference_cents
          }
          return {
            id: row.id.toString(),
            runId: row.run_id,
            comparedAt: row.compared_at,
            outcome: row.outcome as ReportOutcome,
            ...comparison,
            lowestStoreName: row.lowest_store_name,
            differencePercent: differencePercent(comparison),
            storePosition: row.store_position,
            storeCount: row.store_count,
            storeTotalCents: row.store_total_cents,
            lowestTotalCents: row.lowest_total_cents
          }
        }),
        nextCursor: rows.length > query.limit
          ? page[page.length - 1].id.toString()
          : null
      }
    })
  }
}

// The most recent comparison of the offer `o`, read through
// kk_price_comparisons_offer_compared_idx. Offers never compared are left out.
const latestComparison = Prisma.sql`
  CROSS JOIN LATERAL (
    SELECT *
      FROM kk_price_comparisons lc
     WHERE lc.store_offer_id = o.id
     ORDER BY lc.compared_at DESC, lc.id DESC
     LIMIT 1
  ) c`

function stateFilter(state: ReportQuery['state']): Prisma.Sql {
  switch (state) {
    case 'active':
      return Prisma.sql`(o.listing_status = 'listed' AND o.stock > 0)`
    case 'out_of_stock':
      return Prisma.sql`(o.listing_status = 'listed' AND o.stock = 0)`
    case 'delisted':
      return Prisma.sql`o.listing_status = 'delisted'`
    case 'all':
      return Prisma.sql`true`
  }
}

function offerState(listingStatus: string, stock: number): OfferState {
  if (listingStatus === 'delisted') return 'delisted'
  return stock > 0 ? 'active' : 'out_of_stock'
}

function toReportRow(
  row: ReportDbRow,
  run: RunView | null,
  easyAdjustCents: number
): ReportRow {
  const comparison = {
    storePriceCents: row.store_price_cents,
    lowestPriceCents: row.lowest_price_cents,
    differenceCents: row.difference_cents
  }
  return {
    offerId: row.offer_id.toString(),
    offerRef: row.kk_offer_ref,
    sku: row.sku,
    ean: row.ean,
    name: row.name,
    storeUrl: row.store_url,
    productUrl: row.product_url,
    offerState: offerState(row.listing_status, row.stock),
    runId: row.run_id,
    comparedAt: row.compared_at,
    stale: run?.finishedAt != null
      && row.run_id !== run.id
      && row.compared_at < run.finishedAt,
    outcome: row.outcome as ReportOutcome,
    ...comparison,
    storeIsListed: row.store_is_listed,
    lowestStoreName: row.lowest_store_name,
    differencePercent: differencePercent(comparison),
    easyAdjust: isEasyAdjust(row.difference_cents, easyAdjustCents),
    checkLink: needsLinkCheck(comparison),
    storePosition: row.store_position,
    storeCount: row.store_count,
    storeTotalCents: row.store_total_cents,
    lowestTotalCents: row.lowest_total_cents,
    lowestTotalStoreName: row.lowest_total_store_name,
    totalDifferenceCents:
      row.store_total_cents !== null && row.lowest_total_cents !== null
        ? row.store_total_cents - row.lowest_total_cents
        : null
  }
}
