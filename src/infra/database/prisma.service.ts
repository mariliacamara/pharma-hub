import { Logger } from '@nestjs/common'
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { PrismaPg } from '@prisma/adapter-pg'

import { PrismaClient } from '#/generated/prisma/client'
import type { Prisma } from '#/generated/prisma/client'

import { assertStoreId } from './store-id'

/** A Prisma client bound to one transaction already scoped to a store. */
export type StoreTransaction = Prisma.TransactionClient

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
  implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name)

  constructor(databaseUrl: string) {
    super({ adapter: new PrismaPg({ connectionString: databaseUrl }) })
  }

  async onModuleInit(): Promise<void> {
    await this.assertRoleCannotBypassRowLevelSecurity()
    this.logger.log(
      'Database connection ready; role is subject to Row Level Security'
    )
  }

  async onModuleDestroy(): Promise<void> {
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
    work: (tx: StoreTransaction) => Promise<T>
  ): Promise<T> {
    assertStoreId(storeId)
    return this.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT set_config('app.current_store_id', ${storeId}, true)`
      return work(tx)
    })
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
