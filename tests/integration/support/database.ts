import { randomUUID } from 'node:crypto'

import { env } from '#/infra/config/env'
import { PrismaService } from '#/infra/database/prisma.service'

/** Connects as the application role, exactly as the running service does. */
export function appPrisma(): PrismaService {
  return new PrismaService(env.DATABASE_URL)
}

/**
 * Connects as the owner of the tables: the role used by migrations.
 * Tests use it only to prove that the service refuses it.
 */
export function ownerPrisma(): PrismaService {
  const url = process.env.DATABASE_MIGRATION_URL
  if (!url) {
    throw new Error(
      'DATABASE_MIGRATION_URL is required for integration tests'
    )
  }
  return new PrismaService(url)
}

export interface TestStore {
  id: string
  slug: string
}

/** Creates a store with a unique slug, so test files never collide. */
export async function createStore(
  prisma: PrismaService,
  label: string
): Promise<TestStore> {
  const id = randomUUID()
  const slug = `test-${label}-${id.slice(0, 8)}`
  await prisma.stores.create({ data: { id, slug, name: `Test ${label}` } })
  return { id, slug }
}

/** Removes the stores and everything that belongs to them (FKs cascade). */
export async function deleteStores(
  prisma: PrismaService,
  stores: TestStore[]
): Promise<void> {
  await prisma.stores.deleteMany({
    where: { id: { in: stores.map((store) => store.id) } }
  })
}

/**
 * The same client, except that it only knows the stores a test created.
 *
 * The collection worker and the daily schedule look at every store of the
 * hub. Given this client, a test stays inside its own stores, so it can run
 * against a database that also holds others without touching their runs.
 */
export function onlyStores(
  prisma: PrismaService,
  stores: () => readonly TestStore[]
): PrismaService {
  const own = {
    findMany: async () => stores().map(({ id }) => ({ id }))
  }
  return new Proxy(prisma, {
    get(target, property) {
      if (property === 'stores') return own
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}
