import { Logger } from '@nestjs/common'
import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common'
import { PrismaPg } from '@prisma/adapter-pg'

import { PrismaClient } from '#/generated/prisma/client'
import type { Prisma } from '#/generated/prisma/client'

import { assertStoreId } from './store-id'

/** A Prisma client bound to one transaction already scoped to a store. */
export type StoreTransaction = Prisma.TransactionClient

/**
 * Every connection runs in UTC, whatever the database server or the role is
 * configured with.
 *
 * The driver sends and reads `timestamptz` values as text without an offset
 * and assumes that text is UTC. On a session in another time zone every
 * instant written by the application, and every instant read from the
 * database, is silently shifted by that zone's offset. Fixing the session to
 * UTC removes the assumption. Portugal time (decision 0012) is applied when
 * showing and scheduling, never in the session.
 */
const SESSION_OPTIONS = '-c TimeZone=UTC'

export class DatabaseSessionNotUtcError extends Error {
  constructor(timeZone: string) {
    super(
      `Refusing to start: the database session runs in "${timeZone}", not `
      + 'UTC, so stored times would be shifted. Remove any "options" '
      + 'parameter that sets a time zone from DATABASE_URL.'
    )
    this.name = 'DatabaseSessionNotUtcError'
  }
}

export class UnsafeDatabaseRoleError extends Error {
  constructor(reason: string) {
    super(
      `Refusing to start: the database role ${reason}, so Row Level Security `
      + 'would not isolate stores. Connect as pharma_hub_app '
      + '(see db/roles.sql).'
    )
    this.name = 'UnsafeDatabaseRoleError'
  }
}

interface RoleCheckRow {
  rolsuper: boolean
  rolbypassrls: boolean
  owns_protected_table: boolean
}

/**
 * The only database client of the service. Provided by DatabaseModule, which
 * passes the connection string of the application role.
 */
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PrismaService.name)

  constructor(databaseUrl: string) {
    // Written out rather than left to the driver's defaults, so the limits
    // are a decision. Every request that touches a store's data holds one
    // connection for the length of a short transaction.
    const pool = {
      connectionString: databaseUrl,
      options: SESSION_OPTIONS,
      max: 10,
      // Without this a request waits for a free connection forever, and a
      // full pool looks like a hung service instead of an error.
      connectionTimeoutMillis: 10_000,
      // Lets the operating system notice a connection whose other end went
      // away without saying so, instead of waiting on it forever.
      keepAlive: true
    }
    // An idle connection that breaks (the database restarted, the network
    // dropped) is replaced silently by the pool. Say so in the log.
    const report = (error: Error) => {
      Logger.warn(
        `Database connection lost: ${error.message}`,
        PrismaService.name
      )
    }
    super({
      adapter: new PrismaPg(pool, {
        onPoolError: report,
        onConnectionError: report
      })
    })
  }

  async onModuleInit(): Promise<void> {
    await this.assertSessionIsUtc()
    await this.assertRoleCannotBypassRowLevelSecurity()
    this.logger.log(
      'Database connection ready; role is subject to Row Level Security'
    )
  }

  /**
   * Closes the pool in the LAST phase of a shutdown. Whatever is still
   * working when the service is asked to stop (a request being answered,
   * the collection putting its run back in the queue) does so in the
   * earlier phases and still needs the database.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect()
  }

  /**
   * Runs `work` in a transaction scoped to one store.
   *
   * Every table that holds a store's data is protected by a Row Level Security
   * policy keyed on a transaction-local setting. Inside `work`, queries see and
   * write only that store's rows. Outside this method, the same tables return
   * nothing, so a query that forgets to go through here fails closed instead
   * of leaking another store's data.
   *
   * The setting is transaction-local: it cannot leak to the next user of the
   * pooled connection.
   */
  async withStore<T>(
    storeId: string,
    work: (tx: StoreTransaction) => Promise<T>,
    // The default suits a request. A batch that writes many rows in one
    // transaction asks for more.
    options: { timeoutMs?: number } = {}
  ): Promise<T> {
    assertStoreId(storeId)
    return this.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT set_config('app.current_store_id', ${storeId}, true)`
        return work(tx)
      },
      { timeout: options.timeoutMs ?? 5_000 }
    )
  }

  /**
   * The session time zone is set by this class, but a connection string can
   * override it. Checked rather than trusted: see SESSION_OPTIONS.
   */
  async assertSessionIsUtc(): Promise<void> {
    const [{ time_zone: timeZone }] = await this.$queryRaw<
      { time_zone: string }[]
    >`SELECT current_setting('TimeZone') AS time_zone`
    if (!['UTC', 'Etc/UTC'].includes(timeZone)) {
      throw new DatabaseSessionNotUtcError(timeZone)
    }
  }

  /**
   * PostgreSQL lets superusers, roles with BYPASSRLS and table owners ignore
   * Row Level Security without any error. A managed database hands out exactly
   * such a role by default, so this is checked at startup rather than trusted.
   */
  async assertRoleCannotBypassRowLevelSecurity(): Promise<void> {
    const rows = await this.$queryRaw<RoleCheckRow[]>`
      SELECT r.rolsuper,
             r.rolbypassrls,
             EXISTS (
               SELECT 1
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public'
                 AND c.relkind = 'r'
                 AND c.relrowsecurity
                 AND pg_has_role(current_user, c.relowner, 'USAGE')
             ) AS owns_protected_table
      FROM pg_roles r
      WHERE r.rolname = current_user`
    const role = rows[0]
    if (!role) throw new UnsafeDatabaseRoleError('could not be inspected')
    if (role.rolsuper) throw new UnsafeDatabaseRoleError('is a superuser')
    if (role.rolbypassrls) throw new UnsafeDatabaseRoleError('has BYPASSRLS')
    if (role.owns_protected_table) {
      throw new UnsafeDatabaseRoleError('owns protected tables')
    }
  }
}
