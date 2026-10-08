import { Injectable } from '@nestjs/common'

import { toBytes } from '#/infra/database/bytes'
import { PrismaService } from '#/infra/database/prisma.service'
import { AuditService } from '#/modules/audit/services/audit.service'
import type { AuditActor } from '#/modules/audit/services/audit.service'

import {
  CredentialDecryptionError,
  credentialContext,
  openCredential,
  sealCredential
} from '../domain/credential-cipher'
import { CredentialKeyring } from '../domain/credential-keyring'

/** The external systems a store can hold a credential for. */
export type CredentialProvider = 'kuantokusta'

/** What may be shown about a credential. Never the credential itself. */
export interface CredentialStatus {
  provider: CredentialProvider
  configured: boolean
  /** The last four characters, so a person can tell which key is stored. */
  lastFour: string | null
  updatedAt: Date | null
}

export class InvalidCredentialError extends Error {
  constructor() {
    super('The credential must have 8 to 512 characters and no spaces')
    this.name = 'InvalidCredentialError'
  }
}

/**
 * Printable, non-space characters only: a key pasted with a line break or a
 * stray space would be stored and then fail on every call.
 */
export function assertCredentialShape(secret: string): void {
  if (!/^[\x21-\x7e]{8,512}$/.test(secret)) throw new InvalidCredentialError()
}

/**
 * Stores each store's credentials for external systems, encrypted.
 *
 * There are exactly two ways out of here: `status`, which is safe to show,
 * and `revealForOutboundCall`, which returns the secret and exists only so
 * the hub can call the external system itself. No route returns its result.
 */
@Injectable()
export class CredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly keyring: CredentialKeyring,
    private readonly audit: AuditService
  ) {}

  async set(
    input: { storeId: string, provider: CredentialProvider, secret: string },
    actor: AuditActor
  ): Promise<CredentialStatus> {
    const { storeId, provider, secret } = input
    assertCredentialShape(secret)

    const { version, key } = this.keyring.active
    const sealed = sealCredential(
      secret,
      key,
      credentialContext(storeId, provider, version)
    )
    const lastFour = secret.slice(-4)

    return this.prisma.withStore(storeId, async (tx) => {
      const data = {
        ciphertext: toBytes(sealed.ciphertext),
        nonce: toBytes(sealed.nonce),
        key_version: version,
        last_four: lastFour,
        updated_at: new Date()
      }
      const row = await tx.store_credentials.upsert({
        where: { store_id_provider: { store_id: storeId, provider } },
        create: { store_id: storeId, provider, ...data },
        update: data
      })
      await this.audit.record(tx, {
        actor,
        action: 'credential.replaced',
        storeId,
        target: provider,
        details: { provider, keyVersion: version }
      })
      return {
        provider,
        configured: true,
        lastFour: row.last_four,
        updatedAt: row.updated_at
      }
    })
  }

  async status(
    storeId: string,
    provider: CredentialProvider
  ): Promise<CredentialStatus> {
    const row = await this.prisma.withStore(storeId, (tx) =>
      tx.store_credentials.findUnique({
        where: { store_id_provider: { store_id: storeId, provider } },
        select: { last_four: true, updated_at: true }
      })
    )
    return {
      provider,
      configured: row !== null,
      lastFour: row?.last_four ?? null,
      updatedAt: row?.updated_at ?? null
    }
  }

  /**
   * The secret in clear, or null when the store has none.
   *
   * Call it right before the outbound request and let the value go out of
   * scope afterwards. Never log it, return it or put it in an error.
   */
  async revealForOutboundCall(
    storeId: string,
    provider: CredentialProvider
  ): Promise<string | null> {
    const row = await this.prisma.withStore(storeId, (tx) =>
      tx.store_credentials.findUnique({
        where: { store_id_provider: { store_id: storeId, provider } },
        select: { ciphertext: true, nonce: true, key_version: true }
      })
    )
    if (!row) return null

    const key = this.keyring.find(row.key_version)
    // Encrypted with a master key this process was not given.
    if (!key) throw new CredentialDecryptionError()

    return openCredential(
      row,
      key,
      credentialContext(storeId, provider, row.key_version)
    )
  }
}
