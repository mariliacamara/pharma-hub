import { Injectable, Logger } from '@nestjs/common'

import { toBytes } from '#/infra/database/bytes'
import { uuidV7 } from '#/infra/ids/uuid-v7'
import { PrismaService } from '#/infra/database/prisma.service'
import { AuditService } from '#/modules/audit/services/audit.service'
import type { AuditActor } from '#/modules/audit/services/audit.service'

import { generateToken, hashToken } from '../domain/token'
import { isTokenScope } from '../domain/token-principal'
import type { TokenPrincipal, TokenScope } from '../domain/token-principal'

export interface IssuedToken {
  id: string
  /** The secret itself. This is the only time it exists outside the caller. */
  token: string
  prefix: string
}

export interface TokenSummary {
  id: string
  prefix: string
  label: string
  scopes: string[]
  createdAt: Date
  expiresAt: Date | null
  revokedAt: Date | null
  lastUsedAt: Date | null
}

export class InvalidTokenRequestError extends Error {
  constructor(problem: string) {
    super(problem)
    this.name = 'InvalidTokenRequestError'
  }
}

// last_used_at is for a person looking at a list. Writing it on every
// request would turn each read into a write, so it is refreshed at most
// this often.
const LAST_USED_RESOLUTION_MS = 5 * 60 * 1000

/**
 * Issues, verifies and revokes plugin tokens.
 *
 * `api_tokens` is not protected by Row Level Security, because the lookup
 * happens before any store is known. Every query here that is not the
 * lookup itself therefore filters by store explicitly.
 */
@Injectable()
export class ApiTokensService {
  private readonly logger = new Logger(ApiTokensService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async issue(
    input: {
      storeId: string
      label: string
      scopes: readonly TokenScope[]
      expiresAt?: Date
    },
    actor: AuditActor
  ): Promise<IssuedToken> {
    const label = input.label.trim()
    const scopes = [...new Set(input.scopes)]

    if (label === '' || label.length > 120) {
      throw new InvalidTokenRequestError(
        'The label must have 1 to 120 characters'
      )
    }
    if (scopes.length === 0 || !scopes.every(isTokenScope)) {
      throw new InvalidTokenRequestError('At least one valid scope is required')
    }
    if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
      throw new InvalidTokenRequestError('The expiry must be in the future')
    }

    const { token, hash, prefix } = generateToken()
    const id = uuidV7()

    await this.prisma.$transaction(async (tx) => {
      await tx.api_tokens.create({
        data: {
          id,
          store_id: input.storeId,
          token_hash: toBytes(hash),
          token_prefix: prefix,
          label,
          scopes,
          expires_at: input.expiresAt ?? null
        }
      })
      await this.audit.record(tx, {
        actor,
        action: 'api_token.issued',
        storeId: input.storeId,
        target: id,
        details: {
          prefix,
          label,
          scopes,
          expiresAt: input.expiresAt?.toISOString() ?? null
        }
      })
    })

    return { id, token, prefix }
  }

  /**
   * Resolves a token to its store and scopes, or to null.
   *
   * Unknown, revoked and expired tokens all give the same answer, so a
   * caller cannot tell which of the three it holds.
   */
  async authenticate(token: string): Promise<TokenPrincipal | null> {
    const row = await this.prisma.api_tokens.findUnique({
      where: { token_hash: toBytes(hashToken(token)) },
      select: {
        id: true,
        store_id: true,
        token_prefix: true,
        scopes: true,
        expires_at: true,
        revoked_at: true,
        last_used_at: true
      }
    })
    if (!row) return null

    // The caller gets the same answer in every case. The log says which it
    // was, because "the plugin stopped working" is otherwise a guess.
    const now = Date.now()
    if (row.revoked_at) {
      this.logger.warn(`Refused a revoked token prefix=${row.token_prefix}`)
      return null
    }
    if (row.expires_at && row.expires_at.getTime() <= now) {
      this.logger.warn(`Refused an expired token prefix=${row.token_prefix}`)
      return null
    }

    const stale
      = !row.last_used_at
        || now - row.last_used_at.getTime() > LAST_USED_RESOLUTION_MS
    if (stale) await this.touch(row.id, new Date(now))

    return {
      tokenId: row.id,
      tokenPrefix: row.token_prefix,
      storeId: row.store_id,
      scopes: row.scopes.filter(isTokenScope)
    }
  }

  /** Revokes the store's active tokens that start with `prefix`. */
  async revoke(
    input: { storeId: string, prefix: string },
    actor: AuditActor
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.api_tokens.updateMany({
        where: {
          store_id: input.storeId,
          token_prefix: input.prefix,
          revoked_at: null
        },
        data: { revoked_at: new Date() }
      })
      if (count > 0) {
        await this.audit.record(tx, {
          actor,
          action: 'api_token.revoked',
          storeId: input.storeId,
          details: { prefix: input.prefix, count }
        })
      }
      return count
    })
  }

  /** The store's tokens, newest first. Never includes a secret or a hash. */
  async list(storeId: string): Promise<TokenSummary[]> {
    const rows = await this.prisma.api_tokens.findMany({
      where: { store_id: storeId },
      orderBy: { created_at: 'desc' },
      take: 200
    })
    return rows.map((row) => ({
      id: row.id,
      prefix: row.token_prefix,
      label: row.label,
      scopes: row.scopes,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      lastUsedAt: row.last_used_at
    }))
  }

  private async touch(id: string, at: Date): Promise<void> {
    try {
      await this.prisma.api_tokens.update({
        where: { id },
        data: { last_used_at: at }
      })
    } catch (error) {
      // Bookkeeping only: a valid token is not refused because of it.
      this.logger.warn(
        `Could not record the last use of token ${id}`,
        error instanceof Error ? error.message : String(error)
      )
    }
  }
}
