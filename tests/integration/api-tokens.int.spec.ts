import { describe, beforeAll, afterAll, it, expect } from '@jest/globals'

import type { PrismaService } from '#/infra/database/prisma.service'
import { generateToken, hashToken } from '#/modules/api-tokens/domain/token'
import {
  ApiTokensService,
  InvalidTokenRequestError
} from '#/modules/api-tokens/services/api-tokens.service'
import { AuditService } from '#/modules/audit/services/audit.service'

import { appPrisma, createStore, deleteStores } from './support/database'
import type { TestStore } from './support/database'

const CLI = { type: 'system', label: 'integration-test' } as const

describe('plugin tokens', () => {
  let prisma: PrismaService
  let tokens: ApiTokensService
  let storeA: TestStore
  let storeB: TestStore

  beforeAll(async () => {
    prisma = appPrisma()
    await prisma.onModuleInit()
    tokens = new ApiTokensService(prisma, new AuditService())
    storeA = await createStore(prisma, 'tok-a')
    storeB = await createStore(prisma, 'tok-b')
  })

  afterAll(async () => {
    await deleteStores(prisma, [storeA, storeB])
    await prisma.onApplicationShutdown()
  })

  const issue = (store: TestStore, extra = {}) =>
    tokens.issue(
      {
        storeId: store.id,
        label: 'WordPress plugin',
        scopes: ['prices:read'],
        ...extra
      },
      CLI
    )

  it('issues a token that resolves to its store and scopes', async () => {
    const issued = await issue(storeA, {
      scopes: ['prices:read', 'credentials:write']
    })

    expect(await tokens.authenticate(issued.token)).toEqual({
      tokenId: issued.id,
      tokenPrefix: issued.prefix,
      storeId: storeA.id,
      scopes: ['prices:read', 'credentials:write']
    })
  })

  it('stores the hash and never the token', async () => {
    const issued = await issue(storeA)
    const row = await prisma.api_tokens.findUniqueOrThrow({
      where: { id: issued.id }
    })

    expect(Buffer.from(row.token_hash).equals(hashToken(issued.token)))
      .toBe(true)
    expect(JSON.stringify(row)).not.toContain(issued.token)
    expect(JSON.stringify(row)).not.toContain(issued.token.slice(12))
    expect(row.token_prefix).toBe(issued.token.slice(4, 12))
  })

  it('does not know a token that was never issued', async () => {
    expect(await tokens.authenticate(generateToken().token)).toBeNull()
  })

  it('refuses a revoked token, and only the revoked one', async () => {
    const kept = await issue(storeA)
    const revoked = await issue(storeA)

    const count = await tokens.revoke(
      { storeId: storeA.id, prefix: revoked.prefix },
      CLI
    )

    expect(count).toBe(1)
    expect(await tokens.authenticate(revoked.token)).toBeNull()
    expect(await tokens.authenticate(kept.token)).not.toBeNull()
  })

  it('cannot revoke another store\'s token', async () => {
    const issued = await issue(storeA)

    const count = await tokens.revoke(
      { storeId: storeB.id, prefix: issued.prefix },
      CLI
    )

    expect(count).toBe(0)
    expect(await tokens.authenticate(issued.token)).not.toBeNull()
  })

  it('refuses an expired token', async () => {
    const issued = await issue(storeA, {
      expiresAt: new Date(Date.now() + 60_000)
    })

    expect(await tokens.authenticate(issued.token)).not.toBeNull()

    // Moves the whole lifetime into the past, as if time had gone by.
    await prisma.api_tokens.update({
      where: { id: issued.id },
      data: {
        created_at: new Date(Date.now() - 120_000),
        expires_at: new Date(Date.now() - 1000)
      }
    })

    expect(await tokens.authenticate(issued.token)).toBeNull()
  })

  it.each([
    ['an empty label', { label: '  ' }],
    ['no scope', { scopes: [] }],
    ['an unknown scope', { scopes: ['admin'] }],
    ['an expiry in the past', { expiresAt: new Date(Date.now() - 1000) }]
  ])('refuses to issue a token with %s', async (_case, extra) => {
    await expect(issue(storeA, extra)).rejects.toThrow(
      InvalidTokenRequestError
    )
  })

  it('records when a token was last used, without writing on every call', async () => {
    const issued = await issue(storeA)
    const lastUsed = async () =>
      (
        await prisma.api_tokens.findUniqueOrThrow({ where: { id: issued.id } })
      ).last_used_at

    expect(await lastUsed()).toBeNull()

    await tokens.authenticate(issued.token)
    const first = await lastUsed()

    expect(first).not.toBeNull()

    await tokens.authenticate(issued.token)

    expect(await lastUsed()).toEqual(first)
  })

  it('lists a store\'s tokens without secrets, and only that store\'s', async () => {
    await issue(storeB)
    const listed = await tokens.list(storeB.id)

    expect(listed).toHaveLength(1)
    expect(Object.keys(listed[0]).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'id',
      'label',
      'lastUsedAt',
      'prefix',
      'revokedAt',
      'scopes'
    ])
  })

  it('records issuing and revoking in the audit log, without the token', async () => {
    const issued = await issue(storeB)
    await tokens.revoke({ storeId: storeB.id, prefix: issued.prefix }, CLI)

    const events = await prisma.audit_events.findMany({
      where: { store_id: storeB.id },
      orderBy: { id: 'desc' },
      take: 2
    })

    expect(events.map((event) => event.action)).toEqual([
      'api_token.revoked',
      'api_token.issued'
    ])
    expect(events[1].target).toBe(issued.id)
    const recorded = JSON.stringify(
      events.map((event) => [event.details, event.target, event.actor_label])
    )

    expect(recorded).not.toContain(issued.token)
    expect(recorded).not.toContain(issued.token.slice(12))
  })
})
