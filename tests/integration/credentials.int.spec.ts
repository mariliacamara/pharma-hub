import { randomBytes } from 'node:crypto'

import { describe, beforeAll, afterAll, it, expect } from '@jest/globals'

import type { PrismaService } from '#/infra/database/prisma.service'
import { AuditService } from '#/modules/audit/services/audit.service'
import { CredentialDecryptionError } from '#/modules/credentials/domain/credential-cipher'
import { CredentialKeyring } from '#/modules/credentials/domain/credential-keyring'
import {
  CredentialsService,
  InvalidCredentialError
} from '#/modules/credentials/services/credentials.service'

import { appPrisma, createStore, deleteStores } from './support/database'
import type { TestStore } from './support/database'

const CLI = { type: 'system', label: 'integration-test' } as const
const SECRET = 'kk-live-4f9a2c7d1e8b4a6f-ZINCOMED'

describe('store credentials', () => {
  let prisma: PrismaService
  let storeA: TestStore
  let storeB: TestStore
  const keyV1 = { version: 1, key: randomBytes(32) }
  const keyV2 = { version: 2, key: randomBytes(32) }
  const service = (keyring: CredentialKeyring) =>
    new CredentialsService(prisma, keyring, new AuditService())
  let credentials: CredentialsService

  beforeAll(async () => {
    prisma = appPrisma()
    await prisma.onModuleInit()
    storeA = await createStore(prisma, 'cred-a')
    storeB = await createStore(prisma, 'cred-b')
    credentials = service(new CredentialKeyring(keyV1))
  })

  afterAll(async () => {
    await deleteStores(prisma, [storeA, storeB])
    await prisma.onModuleDestroy()
  })

  const rowOf = (store: TestStore) =>
    prisma.withStore(store.id, (tx) =>
      tx.store_credentials.findUniqueOrThrow({
        where: {
          store_id_provider: { store_id: store.id, provider: 'kuantokusta' }
        }
      })
    )

  it('reports a store without a key as not configured', async () => {
    expect(await credentials.status(storeA.id, 'kuantokusta')).toEqual({
      provider: 'kuantokusta',
      configured: false,
      lastFour: null,
      updatedAt: null
    })
    expect(
      await credentials.revealForOutboundCall(storeA.id, 'kuantokusta')
    ).toBeNull()
  })

  it('stores the key encrypted and gives it back only on purpose', async () => {
    const status = await credentials.set(
      { storeId: storeA.id, provider: 'kuantokusta', secret: SECRET },
      CLI
    )

    expect(status).toMatchObject({ configured: true, lastFour: 'OMED' })
    expect(JSON.stringify(status)).not.toContain(SECRET)
    expect(
      await credentials.revealForOutboundCall(storeA.id, 'kuantokusta')
    ).toBe(SECRET)
  })

  it('keeps nothing readable in the database', async () => {
    const row = await rowOf(storeA)
    const stored = Buffer.from(row.ciphertext).toString('latin1')

    expect(row.key_version).toBe(1)
    expect(row.nonce).toHaveLength(12)
    expect(stored).not.toContain(SECRET)
    expect(stored).not.toContain(SECRET.slice(0, 6))
    expect(row.last_four).toBe('OMED')
  })

  it('replaces the key, with a fresh nonce', async () => {
    const before = await rowOf(storeA)

    await credentials.set(
      { storeId: storeA.id, provider: 'kuantokusta', secret: `${SECRET}-2` },
      CLI
    )
    const after = await rowOf(storeA)

    expect(Buffer.from(after.nonce).equals(Buffer.from(before.nonce)))
      .toBe(false)
    expect(
      await credentials.revealForOutboundCall(storeA.id, 'kuantokusta')
    ).toBe(`${SECRET}-2`)
  })

  it('keeps each store to its own key', async () => {
    await credentials.set(
      { storeId: storeB.id, provider: 'kuantokusta', secret: 'key-of-store-b' },
      CLI
    )

    expect(
      await credentials.revealForOutboundCall(storeA.id, 'kuantokusta')
    ).toBe(`${SECRET}-2`)
    expect(
      await credentials.revealForOutboundCall(storeB.id, 'kuantokusta')
    ).toBe('key-of-store-b')
  })

  it('cannot open a ciphertext copied into another store\'s row', async () => {
    const stolen = await rowOf(storeA)
    await prisma.withStore(storeB.id, (tx) =>
      tx.store_credentials.update({
        where: {
          store_id_provider: { store_id: storeB.id, provider: 'kuantokusta' }
        },
        data: { ciphertext: stolen.ciphertext, nonce: stolen.nonce }
      })
    )

    await expect(
      credentials.revealForOutboundCall(storeB.id, 'kuantokusta')
    ).rejects.toThrow(CredentialDecryptionError)
  })

  it('reads old keys after a rotation and writes with the new one', async () => {
    const rotated = service(new CredentialKeyring(keyV2, [keyV1]))

    expect(
      await rotated.revealForOutboundCall(storeA.id, 'kuantokusta')
    ).toBe(`${SECRET}-2`)

    await rotated.set(
      { storeId: storeA.id, provider: 'kuantokusta', secret: SECRET },
      CLI
    )

    expect((await rowOf(storeA)).key_version).toBe(2)
    expect(
      await rotated.revealForOutboundCall(storeA.id, 'kuantokusta')
    ).toBe(SECRET)
  })

  it('fails clearly when the master key of a row is not available', async () => {
    // storeA is now on version 2; this process only has version 1.
    await expect(
      credentials.revealForOutboundCall(storeA.id, 'kuantokusta')
    ).rejects.toThrow(CredentialDecryptionError)

    const wrongKey = service(
      new CredentialKeyring({ version: 2, key: randomBytes(32) })
    )

    await expect(
      wrongKey.revealForOutboundCall(storeA.id, 'kuantokusta')
    ).rejects.toThrow(CredentialDecryptionError)
  })

  it.each([
    ['too short', 'abc'],
    ['empty', ''],
    ['with a space', 'kk live key 0001'],
    ['with a line break', 'kk-live-key-0001\n'],
    ['too long', 'k'.repeat(513)],
    ['with a control character', 'kk-live-key\u0000-0001']
  ])('refuses a key %s, and stores nothing', async (_case, secret) => {
    const before = await rowOf(storeA)

    await expect(
      credentials.set(
        { storeId: storeA.id, provider: 'kuantokusta', secret },
        CLI
      )
    ).rejects.toThrow(InvalidCredentialError)
    expect((await rowOf(storeA)).updated_at).toEqual(before.updated_at)
  })

  it('records each replacement in the audit log, without the key', async () => {
    const events = await prisma.audit_events.findMany({
      where: { store_id: storeA.id, action: 'credential.replaced' },
      orderBy: { id: 'asc' }
    })

    expect(events).toHaveLength(3)
    expect(events[0]).toMatchObject({
      actor_type: 'system',
      actor_label: 'integration-test',
      target: 'kuantokusta',
      details: { provider: 'kuantokusta', keyVersion: 1 }
    })
    expect(
      JSON.stringify(events.map((event) => [event.details, event.target]))
    ).not.toContain('kk-live')
  })
})
