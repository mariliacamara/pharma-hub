import { describe, beforeAll, afterAll, it, expect } from '@jest/globals'

import {
  DatabaseSessionNotUtcError,
  PrismaService
} from '#/infra/database/prisma.service'
import { env } from '#/infra/config/env'

import { appPrisma } from './support/database'

/**
 * The driver exchanges `timestamptz` values as text without an offset. If the
 * session were not in UTC, every instant would be shifted on the way in and
 * on the way out, and the two errors would hide each other in a round trip.
 * So the checks below compare with what the database itself says in UTC.
 */
describe('database session', () => {
  let prisma: PrismaService
  const instant = new Date('2026-07-15T23:49:45.123Z')

  beforeAll(async () => {
    prisma = appPrisma()
    await prisma.onModuleInit()
  })

  afterAll(async () => {
    await prisma.onModuleDestroy()
  })

  it('runs in UTC, whatever the server default is', async () => {
    const [row] = await prisma.$queryRaw<{ zone: string }[]>`
      SELECT current_setting('TimeZone') AS zone`

    expect(row.zone).toBe('UTC')
  })

  it('writes an instant as the instant it is', async () => {
    const [row] = await prisma.$queryRaw<{ utc: string }[]>`
      SELECT to_char(
        ${instant}::timestamptz AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) AS utc`

    expect(row.utc).toBe(instant.toISOString())
  })

  it('reads an instant as the instant it is', async () => {
    const [row] = await prisma.$queryRaw<{ value: Date }[]>`
      SELECT '2026-07-15T23:49:45.123Z'::timestamptz AS value`

    expect(row.value.toISOString()).toBe(instant.toISOString())
  })

  it('agrees with the database about what time it is', async () => {
    const [row] = await prisma.$queryRaw<{ now: Date }[]>`
      SELECT clock_timestamp() AS now`

    expect(Math.abs(row.now.getTime() - Date.now())).toBeLessThan(60_000)
  })

  it('refuses to start when the connection string forces another zone', async () => {
    const separator = env.DATABASE_URL.includes('?') ? '&' : '?'
    const shifted = new PrismaService(
      `${env.DATABASE_URL}${separator}options=-c%20TimeZone%3DAsia/Tokyo`
    )

    await expect(shifted.onModuleInit()).rejects.toThrow(
      DatabaseSessionNotUtcError
    )
    await shifted.$disconnect()
  })
})
