import { Injectable } from '@nestjs/common'

import { isUniqueViolation } from '#/infra/database/prisma-errors'
import { PrismaService } from '#/infra/database/prisma.service'
import { AuditService } from '#/modules/audit/services/audit.service'
import type { AuditActor } from '#/modules/audit/services/audit.service'

import type { StoreIdentity } from '../domain/comparison'

export interface KkStoreSettings {
  /**
   * How the store's own offer is recognised on a KuantoKusta page. Null
   * until the first collection works it out, or an operator sets it.
   */
  identity: StoreIdentity | null
  /** "Easy adjust": the store is more expensive by at most this much. */
  easyAdjustCents: number
}

/** Another store of the hub is already known by that slug or seller id. */
export class KkIdentityTakenError extends Error {
  constructor() {
    super('Another store is already registered with that KuantoKusta identity')
    this.name = 'KkIdentityTakenError'
  }
}

export class InvalidKkSettingsError extends Error {
  constructor(problem: string) {
    super(problem)
    this.name = 'InvalidKkSettingsError'
  }
}

const SLUG = /^[a-z0-9][a-z0-9._-]{0,99}$/
// What the column holds.
export const MAX_SELLER_ID = 2_147_483_647
// The column's default: what a store without settings yet is held to.
export const DEFAULT_EASY_ADJUST_CENTS = 10
export const MAX_EASY_ADJUST_CENTS = 100_000

/** A store's settings for the KuantoKusta module. */
@Injectable()
export class KkStoreSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async get(storeId: string): Promise<KkStoreSettings | null> {
    const row = await this.prisma.withStore(storeId, (tx) =>
      tx.kk_store_settings.findUnique({ where: { store_id: storeId } })
    )
    if (!row) return null
    return {
      identity: row.store_slug === null
        ? null
        : { storeSlug: row.store_slug, sellerId: row.seller_id },
      easyAdjustCents: row.easy_adjust_cents
    }
  }

  /**
   * Records how the store appears on KuantoKusta. Called when the collection
   * works it out by itself, and by an operator who wants to set it by hand.
   */
  async setIdentity(
    storeId: string,
    identity: { storeSlug: string, sellerId?: number | null }
  ): Promise<void> {
    const storeSlug = identity.storeSlug.trim().toLowerCase()
    if (!SLUG.test(storeSlug)) {
      throw new InvalidKkSettingsError(
        'The KuantoKusta slug must be lowercase letters, digits, dots and hyphens'
      )
    }
    const sellerId = identity.sellerId ?? null
    if (
      sellerId !== null
      && !(Number.isInteger(sellerId) && sellerId > 0 && sellerId <= MAX_SELLER_ID)
    ) {
      throw new InvalidKkSettingsError('The seller id must be a positive whole number')
    }

    try {
      await this.prisma.withStore(storeId, (tx) =>
        tx.kk_store_settings.upsert({
          where: { store_id: storeId },
          create: { store_id: storeId, store_slug: storeSlug, seller_id: sellerId },
          update: {
            store_slug: storeSlug,
            seller_id: sellerId,
            updated_at: new Date()
          }
        })
      )
    } catch (error) {
      // Slug and seller id are unique across all stores of the hub.
      if (isUniqueViolation(error)) throw new KkIdentityTakenError()
      throw error
    }
  }

  /**
   * Changes the "easy adjust" threshold. The report reads it on every
   * request, so nothing has to be recalculated. Recorded in the audit log
   * with the previous value.
   */
  async setEasyAdjust(
    storeId: string,
    cents: number,
    actor: AuditActor
  ): Promise<void> {
    if (!Number.isInteger(cents) || cents < 0 || cents > MAX_EASY_ADJUST_CENTS) {
      throw new InvalidKkSettingsError(
        'The easy-adjust threshold must be a whole number of cents'
      )
    }
    await this.prisma.withStore(storeId, async (tx) => {
      const current = await tx.kk_store_settings.findUnique({
        where: { store_id: storeId },
        select: { easy_adjust_cents: true }
      })
      const fromCents = current?.easy_adjust_cents ?? DEFAULT_EASY_ADJUST_CENTS
      if (current && fromCents === cents) return
      // The row may not exist yet: it then holds only the threshold, and the
      // first collection adds how the store appears on KuantoKusta.
      await tx.kk_store_settings.upsert({
        where: { store_id: storeId },
        create: { store_id: storeId, easy_adjust_cents: cents },
        update: { easy_adjust_cents: cents, updated_at: new Date() }
      })
      if (fromCents === cents) return
      await this.audit.record(tx, {
        actor,
        action: 'kk_settings.easy_adjust_changed',
        storeId,
        details: { fromCents, toCents: cents }
      })
    })
  }
}
