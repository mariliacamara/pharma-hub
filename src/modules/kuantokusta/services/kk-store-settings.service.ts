import { Injectable } from '@nestjs/common'

import { isUniqueViolation } from '#/infra/database/prisma-errors'
import { PrismaService } from '#/infra/database/prisma.service'

import type { StoreIdentity } from '../domain/comparison'

export interface KkStoreSettings {
  /** How the store's own offer is recognised on a KuantoKusta page. */
  identity: StoreIdentity
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

/** A store's settings for the KuantoKusta module. */
@Injectable()
export class KkStoreSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(storeId: string): Promise<KkStoreSettings | null> {
    const row = await this.prisma.withStore(storeId, (tx) =>
      tx.kk_store_settings.findUnique({ where: { store_id: storeId } })
    )
    if (!row) return null
    return {
      identity: { storeSlug: row.store_slug, sellerId: row.seller_id },
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

  async setEasyAdjust(storeId: string, cents: number): Promise<void> {
    if (!Number.isInteger(cents) || cents < 0 || cents > 100_000) {
      throw new InvalidKkSettingsError(
        'The easy-adjust threshold must be a whole number of cents'
      )
    }
    const { count } = await this.prisma.withStore(storeId, (tx) =>
      tx.kk_store_settings.updateMany({
        where: { store_id: storeId },
        data: { easy_adjust_cents: cents, updated_at: new Date() }
      })
    )
    if (count === 0) {
      throw new InvalidKkSettingsError(
        'Set how the store appears on KuantoKusta first'
      )
    }
  }
}
