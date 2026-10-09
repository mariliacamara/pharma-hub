import { describe, beforeAll, afterAll, it, expect } from '@jest/globals'
import { randomUUID } from 'node:crypto'

import {
  PrismaService,
  UnsafeDatabaseRoleError
} from '#/infra/database/prisma.service'
import { InvalidStoreIdError } from '#/infra/database/store-id'

import {
  appPrisma,
  createStore,
  deleteStores,
  ownerPrisma
} from './support/database'
import type { TestStore } from './support/database'

/**
 * Proves, against a real PostgreSQL and through Prisma, that one store cannot read or
 * write another store's data. This is the property the whole multi-store design rests on.
 */
describe('tenant isolation', () => {
  let prisma: PrismaService
  let storeA: TestStore
  let storeB: TestStore

  beforeAll(async () => {
    prisma = appPrisma()
    await prisma.onModuleInit()
    storeA = await createStore(prisma, 'a')
    storeB = await createStore(prisma, 'b')
    await prisma.withStore(storeA.id, (tx) =>
      tx.kk_store_settings.create({ data: { store_id: storeA.id, store_slug: storeA.slug } })
    )
    await prisma.withStore(storeB.id, (tx) =>
      tx.kk_store_settings.create({ data: { store_id: storeB.id, store_slug: storeB.slug } })
    )
  })

  afterAll(async () => {
    await deleteStores(prisma, [storeA, storeB])
    await prisma.onApplicationShutdown()
  })

  it('shows a store only its own rows', async () => {
    const seenByA = await prisma.withStore(storeA.id, (tx) => tx.kk_store_settings.findMany())
    const seenByB = await prisma.withStore(storeB.id, (tx) => tx.kk_store_settings.findMany())

    expect(seenByA.map((row) => row.store_id)).toEqual([storeA.id])
    expect(seenByB.map((row) => row.store_id)).toEqual([storeB.id])
  })

  it('cannot read another store\'s row even when asking for it by id', async () => {
    const stolen = await prisma.withStore(storeA.id, (tx) =>
      tx.kk_store_settings.findUnique({ where: { store_id: storeB.id } })
    )
    expect(stolen).toBeNull()
  })

  it('cannot update or delete another store\'s rows', async () => {
    const result = await prisma.withStore(storeA.id, async (tx) => ({
      updated: await tx.kk_store_settings.updateMany({
        where: { store_id: storeB.id },
        data: { easy_adjust_cents: 999 }
      }),
      deleted: await tx.kk_store_settings.deleteMany({ where: { store_id: storeB.id } })
    }))
    expect(result.updated.count).toBe(0)
    expect(result.deleted.count).toBe(0)

    const untouched = await prisma.withStore(storeB.id, (tx) =>
      tx.kk_store_settings.findUniqueOrThrow({ where: { store_id: storeB.id } })
    )
    expect(untouched.easy_adjust_cents).toBe(10)
  })

  it('cannot insert a row that belongs to another store', async () => {
    const attempt = prisma.withStore(storeA.id, (tx) =>
      tx.job_runs.create({
        data: {
          id: randomUUID(),
          store_id: storeB.id,
          job_type: 'kk_full_collection',
          trigger: 'schedule'
        }
      })
    )
    await expect(attempt).rejects.toThrow(/row-level security/i)
  })

  it('returns nothing from tenant tables outside a store scope', async () => {
    expect(await prisma.kk_store_settings.findMany()).toEqual([])
    expect(await prisma.store_credentials.findMany()).toEqual([])
  })

  it('does not leak the store scope to later queries on pooled connections', async () => {
    for (let i = 0; i < 25; i++) {
      await prisma.withStore(storeA.id, (tx) => tx.kk_store_settings.findMany())
      expect(await prisma.kk_store_settings.findMany()).toEqual([])
    }
  })

  it('keeps concurrent transactions of different stores apart', async () => {
    const readSlowly = (store: TestStore) =>
      prisma.withStore(store.id, async (tx) => {
        // Hold the transaction open so the four of them overlap.
        await tx.$queryRaw`SELECT 1 FROM pg_sleep(0.15)`
        return tx.kk_store_settings.findMany()
      })
    const results = await Promise.all([
      readSlowly(storeA),
      readSlowly(storeB),
      readSlowly(storeA),
      readSlowly(storeB)
    ])
    expect(results.map((rows) => rows.map((row) => row.store_id))).toEqual([
      [storeA.id],
      [storeB.id],
      [storeA.id],
      [storeB.id]
    ])
  })

  it('rolls back the work and drops the scope when the work fails', async () => {
    const attempt = prisma.withStore(storeA.id, async (tx) => {
      await tx.kk_store_settings.update({
        where: { store_id: storeA.id },
        data: { easy_adjust_cents: 55 }
      })
      throw new Error('boom')
    })
    await expect(attempt).rejects.toThrow('boom')

    const settings = await prisma.withStore(storeA.id, (tx) =>
      tx.kk_store_settings.findUniqueOrThrow({ where: { store_id: storeA.id } })
    )
    expect(settings.easy_adjust_cents).toBe(10)
    expect(await prisma.kk_store_settings.findMany()).toEqual([])
  })

  it.each(['', 'not-a-uuid', 'x\'; DROP TABLE stores; --', `${randomUUID()} OR 1=1`])(
    'rejects the malformed store id %j before touching the database',
    async (storeId) => {
      await expect(prisma.withStore(storeId, async () => 'ran')).rejects.toThrow(
        InvalidStoreIdError
      )
    }
  )

  it('lets the application append to the audit log but never change it', async () => {
    const event = await prisma.audit_events.create({
      data: { actor_type: 'system', actor_label: 'integration-test', action: 'test.appended' }
    })
    await expect(
      prisma.audit_events.update({ where: { id: event.id }, data: { actor_label: 'tampered' } })
    ).rejects.toThrow(/permission denied/i)
    await expect(prisma.audit_events.delete({ where: { id: event.id } })).rejects.toThrow(
      /permission denied/i
    )
  })
})

describe('database role guard', () => {
  it('accepts the application role', async () => {
    const prisma = appPrisma()
    await expect(prisma.assertRoleCannotBypassRowLevelSecurity()).resolves.toBeUndefined()
    await prisma.$disconnect()
  })

  it('refuses to start as the role that owns the tables', async () => {
    const prisma = ownerPrisma()
    await expect(prisma.onModuleInit()).rejects.toThrow(UnsafeDatabaseRoleError)
    await prisma.$disconnect()
  })
})
