import { Injectable } from '@nestjs/common'

import { uuidV7 } from '#/infra/ids/uuid-v7'
import { isUniqueViolation } from '#/infra/database/prisma-errors'
import { PrismaService } from '#/infra/database/prisma.service'
import { AuditService } from '#/modules/audit/services/audit.service'
import type { AuditActor } from '#/modules/audit/services/audit.service'

export interface Store {
  id: string
  slug: string
  name: string
  brandName: string
}

export class StoreSlugTakenError extends Error {
  constructor(slug: string) {
    super(`A store with the slug "${slug}" already exists`)
    this.name = 'StoreSlugTakenError'
  }
}

export class InvalidStoreError extends Error {
  constructor(problem: string) {
    super(problem)
    this.name = 'InvalidStoreError'
  }
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * The tenants of the service. `stores` is not protected by Row Level
 * Security (a token must be resolved to its store before any store is in
 * scope), so nothing here is reachable from a plugin route.
 */
@Injectable()
export class StoresService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async create(
    input: { slug: string, name: string, brandName?: string },
    actor: AuditActor
  ): Promise<Store> {
    const slug = input.slug.trim()
    const name = input.name.trim()
    const brandName = input.brandName?.trim()

    if (!SLUG.test(slug) || slug.length > 60) {
      throw new InvalidStoreError(
        'The slug must be lowercase letters, digits and single hyphens'
      )
    }
    if (name === '' || name.length > 120) {
      throw new InvalidStoreError('The name must have 1 to 120 characters')
    }
    if (brandName !== undefined && (brandName === '' || brandName.length > 120)) {
      throw new InvalidStoreError('The brand name must have 1 to 120 characters')
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.stores.create({
          data: {
            id: uuidV7(),
            slug,
            name,
            ...(brandName === undefined ? {} : { brand_name: brandName })
          }
        })
        await this.audit.record(tx, {
          actor,
          action: 'store.created',
          storeId: row.id,
          target: row.id,
          details: { slug }
        })
        return toStore(row)
      })
    } catch (error) {
      // The UNIQUE constraint on the slug is what guarantees this, also
      // when two requests arrive at once.
      if (isUniqueViolation(error)) throw new StoreSlugTakenError(slug)
      throw error
    }
  }

  async findById(id: string): Promise<Store | null> {
    const row = await this.prisma.stores.findUnique({ where: { id } })
    return row ? toStore(row) : null
  }

  async findBySlug(slug: string): Promise<Store | null> {
    const row = await this.prisma.stores.findUnique({ where: { slug } })
    return row ? toStore(row) : null
  }

  /** Every store. Operator use only: the number of stores is small. */
  async list(): Promise<Store[]> {
    const rows = await this.prisma.stores.findMany({
      orderBy: { created_at: 'asc' },
      take: 500
    })
    return rows.map(toStore)
  }
}

function toStore(row: {
  id: string
  slug: string
  name: string
  brand_name: string
}): Store {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    brandName: row.brand_name
  }
}
