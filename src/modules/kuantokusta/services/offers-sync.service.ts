import { Injectable, Logger } from '@nestjs/common'

import { PrismaService } from '#/infra/database/prisma.service'
import type { StoreTransaction } from '#/infra/database/prisma.service'
import { AuditService } from '#/modules/audit/services/audit.service'
import type { AuditActor } from '#/modules/audit/services/audit.service'
import { CredentialsService } from '#/modules/credentials/services/credentials.service'

import { planOfferSync } from '../domain/offer-sync-plan'
import { readSellerOffers } from '../domain/seller-offer'
import type { SellerOffer, SkipReason } from '../domain/seller-offer'
import {
  KkSellerApiClient,
  KkUnexpectedResponseError
} from './seller-api.client'

/** The store has no KuantoKusta key yet, so there is nothing to call with. */
export class KkCredentialMissingError extends Error {
  constructor() {
    super('This store has no KuantoKusta API key configured')
    this.name = 'KkCredentialMissingError'
  }
}

export interface OffersSyncResult {
  /** Items the API returned. */
  fetched: number
  created: number
  updated: number
  /** Stored offers the API no longer returns, now marked as delisted. */
  delisted: number
  /** Items left out, by reason. Empty when every item was usable. */
  skipped: Partial<Record<SkipReason | 'conflicting_identity', number>>
  /**
   * Why no offer was marked as delisted this time, or null when delisting
   * ran normally (even if it found nothing to delist).
   */
  delistingHeldBack: 'items_skipped' | 'too_many_at_once' | null
  /** How many listed offers were missing from the answer. */
  missing: number
  /** Offers in the answer without a SKU, and without an EAN. */
  withoutSku: number
  withoutEan: number
  durationMs: number
}

export interface OffersSyncOptions {
  /**
   * Delist however many offers are missing. Without it, a sync that would
   * delist a large share of the catalogue at once holds back, because that
   * looks far more like a faulty answer than like a store emptying itself.
   */
  allowMassDelisting?: boolean
}

/**
 * Up to this many offers, or this share of the listed ones if that is more,
 * may disappear in one sync without anyone confirming it.
 */
const MASS_DELISTING = { offers: 10, share: 0.2 }

// The whole write is one transaction over a few statements. Generous on
// purpose: a slow database should delay a sync, not corrupt it.
const WRITE_TIMEOUT_MS = 60_000

/**
 * Copies the store's own offers from the Seller API into the hub.
 *
 * Safe to run again at any time: the same response leads to the same rows.
 * Two runs for the same store do not interleave; the second waits for the
 * first.
 */
@Injectable()
export class OffersSyncService {
  private readonly logger = new Logger(OffersSyncService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialsService,
    private readonly sellerApi: KkSellerApiClient,
    private readonly audit: AuditService
  ) {}

  async sync(
    storeId: string,
    actor: AuditActor,
    options: OffersSyncOptions = {}
  ): Promise<OffersSyncResult> {
    const startedAt = Date.now()
    this.logger.log(`Offers sync started store=${storeId}`)

    try {
      const result = await this.run(storeId, actor, options, startedAt)
      const line
        = `Offers sync finished store=${storeId} `
          + `fetched=${result.fetched} created=${result.created} `
          + `updated=${result.updated} delisted=${result.delisted} `
          + `missing=${result.missing} `
          + `held_back=${result.delistingHeldBack ?? 'no'} `
          + `skipped=${JSON.stringify(result.skipped)} `
          + `without_sku=${result.withoutSku} `
          + `without_ean=${result.withoutEan} ms=${result.durationMs}`
      // Anything left out or held back deserves a second look.
      if (result.delistingHeldBack || Object.keys(result.skipped).length > 0) {
        this.logger.warn(line)
      } else {
        this.logger.log(line)
      }
      return result
    } catch (error) {
      this.logger.error(
        `Offers sync failed store=${storeId} ms=${Date.now() - startedAt} `
        + describeFailure(error)
      )
      throw error
    }
  }

  private async run(
    storeId: string,
    actor: AuditActor,
    options: OffersSyncOptions,
    startedAt: number
  ): Promise<OffersSyncResult> {
    const apiKey = await this.credentials.revealForOutboundCall(
      storeId,
      'kuantokusta'
    )
    if (!apiKey) throw new KkCredentialMissingError()

    // The network call happens before the transaction opens, so no database
    // connection is held while waiting for a third party.
    const items = await this.sellerApi.fetchAllOffers(apiKey, storeId)
    const { offers, skipped } = readSellerOffers(items)

    // Items came back and none could be read: the format changed. Storing
    // that as "the store has no offers" would be a lie.
    if (items.length > 0 && offers.length === 0) {
      throw new KkUnexpectedResponseError(
        `none of the ${items.length} items could be read`
      )
    }

    const written = await this.prisma.withStore(
      storeId,
      (tx) => this.write(tx, storeId, offers, skipped, actor, options),
      { timeoutMs: WRITE_TIMEOUT_MS }
    )

    return {
      fetched: items.length,
      ...written,
      withoutSku: offers.filter((offer) => offer.sku === null).length,
      withoutEan: offers.filter((offer) => offer.ean === null).length,
      durationMs: Date.now() - startedAt
    }
  }

  private async write(
    tx: StoreTransaction,
    storeId: string,
    offers: readonly SellerOffer[],
    skippedWhileReading: Partial<Record<SkipReason, number>>,
    actor: AuditActor,
    options: OffersSyncOptions
  ): Promise<
    Pick<
      OffersSyncResult,
      | 'created'
      | 'updated'
      | 'delisted'
      | 'skipped'
      | 'delistingHeldBack'
      | 'missing'
    >
  > {
    // One sync per store at a time. Released when the transaction ends.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`kk_offers_sync:${storeId}`}, 0)
      )`

    // Taken after the lock, so it only moves forward from one sync of this
    // store to the next. Every row this sync touches gets this timestamp;
    // a listed row with an older one was not in the response.
    const [{ seen_at: seenAt }] = await tx.$queryRaw<{ seen_at: Date }[]>`
      SELECT clock_timestamp() AS seen_at`

    // Bounded by the size of one store's catalogue on KuantoKusta.
    const stored = await tx.kk_store_offers.findMany({
      select: {
        id: true,
        kk_offer_ref: true,
        kk_products: { select: { external_id: true } }
      }
    })
    const plan = planOfferSync(
      stored.map((row) => ({
        id: row.id,
        offerRef: row.kk_offer_ref,
        productExternalId: Number(row.kk_products.external_id)
      })),
      offers
    )

    const skipped: OffersSyncResult['skipped'] = { ...skippedWhileReading }
    if (plan.conflicts.length > 0) {
      skipped.conflicting_identity = plan.conflicts.length
    }

    const accepted = [
      ...plan.inserts,
      ...plan.updates.map((update) => update.offer)
    ]
    await this.upsertProducts(tx, accepted)
    await this.updateOffers(tx, plan.updates, seenAt)
    await this.insertOffers(tx, storeId, plan.inserts, seenAt)

    // Listed offers this answer did not mention.
    const [{ listed, missing }] = await tx.$queryRaw<
      { listed: number, missing: number }[]
    >`
      SELECT count(*)::int AS listed,
             (count(*) FILTER (WHERE last_seen_at < ${seenAt}))::int AS missing
        FROM kk_store_offers
       WHERE store_id = ${storeId}::uuid
         AND listing_status = 'listed'`

    const heldBack = this.whyHoldBackDelisting(skipped, missing, listed, options)
    const delisted = heldBack
      ? 0
      : await tx.$executeRaw`
          UPDATE kk_store_offers
             SET listing_status = 'delisted'
           WHERE store_id = ${storeId}::uuid
             AND listing_status = 'listed'
             AND last_seen_at < ${seenAt}`

    const counts = {
      created: plan.inserts.length,
      updated: plan.updates.length,
      delisted
    }
    await this.audit.record(tx, {
      actor,
      action: 'kk_offers.synced',
      storeId,
      details: {
        ...counts,
        missing,
        skipped,
        delistingHeldBack: heldBack,
        massDelistingAllowed: options.allowMassDelisting === true
      }
    })

    return { ...counts, skipped, delistingHeldBack: heldBack, missing }
  }

  private whyHoldBackDelisting(
    skipped: OffersSyncResult['skipped'],
    missing: number,
    listed: number,
    options: OffersSyncOptions
  ): OffersSyncResult['delistingHeldBack'] {
    // An offer may be missing only because its item could not be read.
    // Delisting waits for an answer in which every item was usable.
    if (Object.keys(skipped).length > 0) return 'items_skipped'

    // An empty or cut-short answer looks exactly like a catalogue that
    // vanished. Small changes go through; a large one waits for a person.
    const limit = Math.max(
      MASS_DELISTING.offers,
      Math.ceil(listed * MASS_DELISTING.share)
    )
    if (missing > limit && !options.allowMassDelisting) {
      return 'too_many_at_once'
    }
    return null
  }

  /**
   * Products are shared by every store that sells them. Rows are written in
   * id order, so two stores syncing the same products at the same moment
   * take their locks in the same order and cannot deadlock.
   */
  private async upsertProducts(
    tx: StoreTransaction,
    offers: readonly SellerOffer[]
  ): Promise<void> {
    if (offers.length === 0) return
    const rows = JSON.stringify(
      offers.map((offer) => ({
        external_id: offer.productExternalId,
        url: offer.productUrl,
        name: offer.productName
      }))
    )
    await tx.$executeRaw`
      INSERT INTO kk_products (external_id, url, name)
      SELECT i.external_id, i.url, i.name
        FROM jsonb_to_recordset(${rows}::jsonb)
          AS i(external_id bigint, url text, name text)
       ORDER BY i.external_id
      ON CONFLICT (external_id) DO UPDATE
        SET url = EXCLUDED.url, name = EXCLUDED.name, updated_at = now()
        WHERE (kk_products.url, kk_products.name)
              IS DISTINCT FROM (EXCLUDED.url, EXCLUDED.name)`
  }

  private async updateOffers(
    tx: StoreTransaction,
    updates: readonly { id: bigint, offer: SellerOffer }[],
    seenAt: Date
  ): Promise<void> {
    if (updates.length === 0) return
    const rows = JSON.stringify(
      updates.map(({ id, offer }) => ({ id: id.toString(), ...toRow(offer) }))
    )
    await tx.$executeRaw`
      UPDATE kk_store_offers AS o
         SET product_id     = p.id,
             kk_offer_ref   = i.kk_offer_ref,
             sku            = i.sku,
             ean            = i.ean,
             name           = i.name,
             store_url      = i.store_url,
             price_cents    = i.price_cents,
             stock          = i.stock,
             is_top_box     = i.is_top_box,
             listing_status = 'listed',
             kk_updated_at  = i.kk_updated_at,
             -- Never before first_seen_at, even if the database clock was
             -- set back since the row was created.
             last_seen_at   = GREATEST(o.first_seen_at, ${seenAt})
        FROM jsonb_to_recordset(${rows}::jsonb)
          AS i(id bigint, external_id bigint, kk_offer_ref text, sku text,
               ean text, name text, store_url text, price_cents integer,
               stock integer, is_top_box boolean, kk_updated_at timestamptz)
        JOIN kk_products AS p ON p.external_id = i.external_id
       WHERE o.id = i.id`
  }

  private async insertOffers(
    tx: StoreTransaction,
    storeId: string,
    inserts: readonly SellerOffer[],
    seenAt: Date
  ): Promise<void> {
    if (inserts.length === 0) return
    const rows = JSON.stringify(inserts.map(toRow))
    await tx.$executeRaw`
      INSERT INTO kk_store_offers
        (store_id, product_id, kk_offer_ref, sku, ean, name, store_url,
         price_cents, stock, is_top_box, kk_updated_at,
         first_seen_at, last_seen_at)
      SELECT ${storeId}::uuid, p.id, i.kk_offer_ref, i.sku, i.ean, i.name,
             i.store_url, i.price_cents, i.stock, i.is_top_box,
             i.kk_updated_at, ${seenAt}, ${seenAt}
        FROM jsonb_to_recordset(${rows}::jsonb)
          AS i(external_id bigint, kk_offer_ref text, sku text, ean text,
               name text, store_url text, price_cents integer, stock integer,
               is_top_box boolean, kk_updated_at timestamptz)
        JOIN kk_products AS p ON p.external_id = i.external_id`
  }
}

function toRow(offer: SellerOffer) {
  return {
    external_id: offer.productExternalId,
    kk_offer_ref: offer.offerRef,
    sku: offer.sku,
    ean: offer.ean,
    name: offer.name,
    store_url: offer.storeUrl,
    price_cents: offer.priceCents,
    stock: offer.stock,
    is_top_box: offer.isTopBox,
    kk_updated_at: offer.updatedAt?.toISOString() ?? null
  }
}

/**
 * What went wrong, for the log. The messages of this module's own errors
 * are written to be safe to log; a database error is reduced to its code.
 */
function describeFailure(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'error=unknown'

  const name = 'name' in error && typeof error.name === 'string'
    ? error.name
    : 'unknown'
  if (name.startsWith('Kk') || name.startsWith('Credential')) {
    const reason = 'message' in error ? String(error.message) : ''
    return `error=${name} reason="${reason}"`
  }
  const code = 'code' in error && typeof error.code === 'string'
    ? error.code
    : '-'
  return `error=${name} code=${code}`
}
