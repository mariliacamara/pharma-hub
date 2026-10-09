import { parseArgs } from 'node:util'

import {
  isTokenScope,
  TOKEN_SCOPES
} from '#/modules/api-tokens/domain/token-principal'
import type { ApiTokensService } from '#/modules/api-tokens/services/api-tokens.service'
import type { AuditActor } from '#/modules/audit/services/audit.service'
import { RunTooSoonError } from '#/modules/kuantokusta/services/collection-runs.service'
import type {
  CollectionRunsService,
  RunView
} from '#/modules/kuantokusta/services/collection-runs.service'
import type { KkCredentialService } from '#/modules/kuantokusta/services/kk-credential.service'
import {
  DEFAULT_EASY_ADJUST_CENTS,
  InvalidKkSettingsError,
  KkIdentityTakenError
} from '#/modules/kuantokusta/services/kk-store-settings.service'
import type { KkStoreSettingsService } from '#/modules/kuantokusta/services/kk-store-settings.service'
import type { OffersSyncService } from '#/modules/kuantokusta/services/offers-sync.service'
import type { OffersService } from '#/modules/kuantokusta/services/offers.service'
import type {
  Store,
  StoresService
} from '#/modules/stores/services/stores.service'

/**
 * Operator commands.
 *
 * They exist because creating a store and issuing its first token have to
 * happen before any token exists, and the admin API with sign-in is not
 * built yet. They run inside the service's own container, as the same
 * database role as the service, so whoever can run them could already reach
 * the database. Every change they make is written to the audit log.
 */
export interface CliServices {
  stores: Pick<StoresService, 'create' | 'findBySlug' | 'list'>
  tokens: Pick<ApiTokensService, 'issue' | 'list' | 'revoke'>
  kkCredential: Pick<KkCredentialService, 'replace' | 'status' | 'isReadable'>
  kkOffersSync: Pick<OffersSyncService, 'sync'>
  kkOffers: Pick<OffersService, 'count'>
  kkRuns: Pick<CollectionRunsService, 'request' | 'list' | 'summary'>
  kkSettings: Pick<
    KkStoreSettingsService,
    'get' | 'setIdentity' | 'setEasyAdjust'
  >
}

export interface CliIo {
  write(line: string): void
  /** Asks for a secret without showing it on the screen. */
  readSecret(prompt: string): Promise<string>
}

/** The command ran and found a problem. Shown without the usage. */
export class CheckFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CheckFailedError'
  }
}

/** The command line was wrong. The message is shown with the usage. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export const USAGE = `Usage: node dist/cli.js <command> [options]

Stores
  store:create --slug <slug> --name <name> [--brand <name shown to the client>]
  store:list

Plugin tokens
  token:issue  --store <slug> --label <text>
               [--scopes ${TOKEN_SCOPES.join(',')}]
               [--expires-in-days <n>]
  token:list   --store <slug>
  token:revoke --store <slug> --prefix <first 8 characters>

KuantoKusta
  kk:set-key      --store <slug>   (asks for the key; it is not shown)
  kk:sync-offers  --store <slug> [--allow-mass-delisting]
  kk:status       --store <slug>
  kk:check-keys                    (can every stored key still be decrypted?)

KuantoKusta price collection
  kk:collect      --store <slug> [--ignore-wait]
                  (queues a collection; the running service carries it out)
  kk:runs         --store <slug>   (the latest collections and their results)
  kk:configure    --store <slug> [--kk-slug <the store's name in KuantoKusta
                  addresses>] [--seller-id <n>] [--easy-adjust-cents <n>]
`

const ACTOR: AuditActor = { type: 'system', label: 'cli' }

type Options = Record<string, string | undefined>

/**
 * Reads `--name value` options. A name in `flags` takes no value: it is
 * either present ("true") or absent.
 */
function parseOptions(
  args: string[],
  names: readonly string[],
  flags: readonly string[] = []
): Options {
  try {
    const { values } = parseArgs({
      args,
      options: {
        ...Object.fromEntries(
          names.map((name) => [name, { type: 'string' as const }])
        ),
        ...Object.fromEntries(
          flags.map((name) => [name, { type: 'boolean' as const }])
        )
      },
      allowPositionals: false,
      strict: true
    })
    return Object.fromEntries(
      Object.entries(values).map(([name, value]) => [
        name,
        typeof value === 'boolean' ? String(value) : value
      ])
    )
  } catch (error) {
    // The parser's own message names the offending option.
    const message
      = typeof error === 'object'
        && error !== null
        && 'message' in error
        && typeof error.message === 'string'
        ? error.message
        : 'The options could not be read'
    throw new UsageError(message)
  }
}

function required(options: Options, name: string): string {
  const value = options[name]?.trim()
  if (!value) throw new UsageError(`--${name} is required`)
  return value
}

export async function runCommand(
  argv: string[],
  services: CliServices,
  io: CliIo
): Promise<void> {
  const [command, ...args] = argv

  const storeOf = async (options: Options): Promise<Store> => {
    const slug = required(options, 'store')
    const store = await services.stores.findBySlug(slug)
    if (!store) throw new UsageError(`There is no store with the slug "${slug}"`)
    return store
  }

  switch (command) {
    case 'store:create': {
      const options = parseOptions(args, ['slug', 'name', 'brand'])
      const store = await services.stores.create(
        {
          slug: required(options, 'slug'),
          name: required(options, 'name'),
          brandName: options.brand
        },
        ACTOR
      )
      io.write(`Store created: ${store.slug} (${store.name})`)
      io.write(`Shown to the client as: ${store.brandName}`)
      return
    }

    case 'store:list': {
      parseOptions(args, [])
      const stores = await services.stores.list()
      if (stores.length === 0) io.write('No stores yet.')
      for (const store of stores) {
        io.write(`${store.slug}\t${store.name}\t${store.brandName}`)
      }
      return
    }

    case 'token:issue': {
      const options = parseOptions(args, [
        'store',
        'label',
        'scopes',
        'expires-in-days'
      ])
      const store = await storeOf(options)
      const scopes = (options.scopes ?? TOKEN_SCOPES.join(','))
        .split(',')
        .map((scope) => scope.trim())
        .filter((scope) => scope !== '')
      const unknown = scopes.filter((scope) => !isTokenScope(scope))
      if (scopes.length === 0 || unknown.length > 0) {
        throw new UsageError(
          `--scopes must be a comma-separated list of: ${TOKEN_SCOPES.join(', ')}`
        )
      }

      let expiresAt: Date | undefined
      if (options['expires-in-days'] !== undefined) {
        const days = Number(options['expires-in-days'])
        if (!Number.isInteger(days) || days < 1 || days > 3650) {
          throw new UsageError('--expires-in-days must be a whole number of days')
        }
        expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
      }

      const issued = await services.tokens.issue(
        {
          storeId: store.id,
          label: required(options, 'label'),
          scopes: scopes.filter(isTokenScope),
          expiresAt
        },
        ACTOR
      )
      io.write(`Token issued for the store "${store.slug}":`)
      io.write('')
      io.write(`  ${issued.token}`)
      io.write('')
      io.write('This is the only time it is shown. Copy it into the plugin now.')
      io.write(`Prefix: ${issued.prefix}`)
      io.write(`Scopes: ${scopes.join(', ')}`)
      io.write(`Expires: ${expiresAt?.toISOString() ?? 'never'}`)
      return
    }

    case 'token:list': {
      const options = parseOptions(args, ['store'])
      const store = await storeOf(options)
      const tokens = await services.tokens.list(store.id)
      if (tokens.length === 0) io.write('No tokens yet.')
      for (const token of tokens) {
        const state = token.revokedAt
          ? 'revoked'
          : token.expiresAt && token.expiresAt.getTime() <= Date.now()
            ? 'expired'
            : 'active'
        io.write(
          [
            token.prefix,
            state,
            token.label,
            token.scopes.join(','),
            `last used: ${token.lastUsedAt?.toISOString() ?? 'never'}`
          ].join('\t')
        )
      }
      return
    }

    case 'token:revoke': {
      const options = parseOptions(args, ['store', 'prefix'])
      const store = await storeOf(options)
      const prefix = required(options, 'prefix')
      const count = await services.tokens.revoke(
        { storeId: store.id, prefix },
        ACTOR
      )
      io.write(
        count === 0
          ? `No active token of "${store.slug}" starts with ${prefix}.`
          : `Revoked ${count} token(s) starting with ${prefix}.`
      )
      return
    }

    case 'kk:set-key': {
      const options = parseOptions(args, ['store'])
      const store = await storeOf(options)
      // Asked for, never taken from the command line: arguments end up in
      // the shell history and in the list of running processes.
      const apiKey = (
        await io.readSecret('KuantoKusta Seller API key (not shown): ')
      ).trim()
      if (apiKey === '') throw new UsageError('No key was entered')

      const status = await services.kkCredential.replace(
        store.id,
        apiKey,
        ACTOR
      )
      io.write(
        `KuantoKusta accepted the key. Stored encrypted for "${store.slug}", `
        + `ending in ${status.lastFour}.`
      )
      return
    }

    case 'kk:sync-offers': {
      const options = parseOptions(args, ['store'], ['allow-mass-delisting'])
      const store = await storeOf(options)
      const result = await services.kkOffersSync.sync(store.id, ACTOR, {
        allowMassDelisting: options['allow-mass-delisting'] === 'true'
      })
      io.write(`Offers of "${store.slug}" copied from KuantoKusta.`)
      io.write(`  returned by the API: ${result.fetched}`)
      io.write(`  new:                 ${result.created}`)
      io.write(`  updated:             ${result.updated}`)
      io.write(`  no longer listed:    ${result.delisted}`)
      io.write(`  without SKU / EAN:   ${result.withoutSku} / ${result.withoutEan}`)
      for (const [reason, count] of Object.entries(result.skipped)) {
        io.write(`  skipped (${reason}): ${count}`)
      }
      if (result.delistingHeldBack === 'items_skipped') {
        io.write(
          '  Some items were skipped, so no offer was marked as delisted '
          + 'this time.'
        )
      }
      if (result.delistingHeldBack === 'too_many_at_once') {
        io.write(
          `  ${result.missing} listed offers were missing from the answer. `
          + 'That is too many to delist without confirmation, so none was.'
        )
        io.write(
          '  If the store really removed them, run again with '
          + '--allow-mass-delisting.'
        )
      }
      return
    }

    case 'kk:collect': {
      const options = parseOptions(args, ['store'], ['ignore-wait'])
      const store = await storeOf(options)
      const status = await services.kkCredential.status(store.id)
      if (!status.configured) {
        throw new CheckFailedError(
          `"${store.slug}" has no KuantoKusta key yet. Run kk:set-key first.`
        )
      }

      let outcome: { run: RunView, created: boolean }
      try {
        outcome = await services.kkRuns.request(
          store.id,
          {
            trigger: 'manual',
            requestedBy: 'cli',
            ignoreWait: options['ignore-wait'] === 'true'
          },
          ACTOR
        )
      } catch (error) {
        if (!(error instanceof RunTooSoonError)) throw error
        throw new CheckFailedError(
          'A collection finished a moment ago. Its result is the current '
          + `one: see kk:runs. To run again anyway, wait `
          + `${Math.ceil(error.retryAfterSeconds / 60)} minute(s) or add `
          + '--ignore-wait.'
        )
      }

      io.write(
        outcome.created
          ? `Collection queued for "${store.slug}": ${outcome.run.id}`
          : `"${store.slug}" already has a collection ${outcome.run.status}: `
            + outcome.run.id
      )
      io.write(
        'The running service carries it out, one product page every few '
        + 'seconds.'
      )
      io.write(`Follow it with: kk:runs --store ${store.slug}`)
      return
    }

    case 'kk:runs': {
      const options = parseOptions(args, ['store'])
      const store = await storeOf(options)
      const runs = await services.kkRuns.list(store.id, 10)
      if (runs.length === 0) {
        io.write('No collections yet.')
        return
      }
      for (const run of runs) {
        io.write(
          [
            run.queuedAt.toISOString(),
            run.status + (run.errorCode ? ` (${run.errorCode})` : ''),
            `pages read ${run.itemsOk}, not read ${run.itemsFailed}, `
            + `of ${run.itemsTotal}`,
            run.trigger === 'schedule' ? 'scheduled' : `by ${run.requestedBy}`,
            run.id
          ].join('\t')
        )
      }
      const [latest] = runs
      if (latest.finishedAt) {
        const counts = await services.kkRuns.summary(store.id, latest.id)
        io.write('')
        io.write('Latest collection, offer by offer:')
        io.write(`  cheapest:           ${counts.cheapest}`)
        io.write(`  tied for cheapest:  ${counts.tied}`)
        io.write(`  more expensive:     ${counts.more_expensive}`)
        io.write(`  only store selling: ${counts.only_store}`)
        io.write(`  page not read:      ${counts.no_data}`)
      }
      return
    }

    case 'kk:configure': {
      const options = parseOptions(args, [
        'store',
        'kk-slug',
        'seller-id',
        'easy-adjust-cents'
      ])
      const store = await storeOf(options)
      const kkSlug = options['kk-slug']?.trim()
      const wholeNumber = (name: string, max: number): number | undefined => {
        const text = options[name]
        if (text === undefined) return undefined
        if (!/^\d{1,9}$/.test(text.trim()) || Number(text) > max) {
          throw new UsageError(`--${name} must be a whole number`)
        }
        return Number(text)
      }
      const sellerId = wholeNumber('seller-id', 2_000_000_000)
      const easyAdjust = wholeNumber('easy-adjust-cents', 100_000)
      if (sellerId !== undefined && !kkSlug) {
        throw new UsageError('--seller-id needs --kk-slug')
      }
      if (!kkSlug && easyAdjust === undefined) {
        throw new UsageError('Nothing to change: give --kk-slug or --easy-adjust-cents')
      }

      try {
        if (kkSlug) {
          await services.kkSettings.setIdentity(store.id, {
            storeSlug: kkSlug,
            sellerId: sellerId ?? null
          })
        }
        if (easyAdjust !== undefined) {
          await services.kkSettings.setEasyAdjust(store.id, easyAdjust, ACTOR)
        }
      } catch (error) {
        if (
          error instanceof InvalidKkSettingsError
          || error instanceof KkIdentityTakenError
        ) {
          throw new CheckFailedError(error.message)
        }
        throw error
      }

      const settings = await services.kkSettings.get(store.id)
      io.write(`Settings of "${store.slug}" for KuantoKusta:`)
      io.write(`  appears on KuantoKusta as: ${settings?.identity?.storeSlug ?? 'not known yet'}`)
      io.write(`  seller id:                 ${settings?.identity?.sellerId ?? 'not known yet'}`)
      io.write(`  easy adjust up to:         ${settings?.easyAdjustCents} cents`)
      return
    }

    case 'kk:check-keys': {
      parseOptions(args, [])
      const stores = await services.stores.list()
      let unreadable = 0
      for (const store of stores) {
        const state = await services.kkCredential.isReadable(store.id)
        if (state === 'unreadable') unreadable++
        io.write(`${store.slug}\t${state.replace('_', ' ')}`)
      }
      if (stores.length === 0) io.write('No stores yet.')
      if (unreadable > 0) {
        throw new CheckFailedError(
          `${unreadable} stored key(s) cannot be decrypted with the master `
          + 'keys in this environment. Check CREDENTIALS_MASTER_KEY and '
          + 'CREDENTIALS_PREVIOUS_KEYS before anything else.'
        )
      }
      return
    }

    case 'kk:status': {
      const options = parseOptions(args, ['store'])
      const store = await storeOf(options)
      const status = await services.kkCredential.status(store.id)
      const offers = await services.kkOffers.count(store.id)
      io.write(
        status.configured
          ? `Key: configured, ending in ${status.lastFour} `
          + `(set ${status.updatedAt?.toISOString()})`
          : 'Key: not configured'
      )
      io.write(`Offers: ${offers.listed} listed, ${offers.delisted} delisted`)

      const settings = await services.kkSettings.get(store.id)
      io.write(
        settings?.identity
          ? `Appears on KuantoKusta as: ${settings.identity.storeSlug} `
          + `(seller id ${settings.identity.sellerId ?? 'not known yet'})`
          : 'Appears on KuantoKusta as: not known yet '
            + '(the first collection works it out)'
      )
      io.write(
        `Easy adjust up to ${settings?.easyAdjustCents ?? DEFAULT_EASY_ADJUST_CENTS} cents`
      )
      const [latest] = await services.kkRuns.list(store.id, 1)
      io.write(
        latest
          ? `Latest collection: ${latest.status}`
          + (latest.errorCode ? ` (${latest.errorCode})` : '')
          + `, asked for ${latest.queuedAt.toISOString()}`
          : 'Latest collection: none yet'
      )
      return
    }

    default:
      throw new UsageError(
        command ? `Unknown command: ${command}` : 'No command given'
      )
  }
}
