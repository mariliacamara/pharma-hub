import { Injectable } from '@nestjs/common'

import type { AuditActor } from '#/modules/audit/services/audit.service'
import { CredentialDecryptionError } from '#/modules/credentials/domain/credential-cipher'
import {
  assertCredentialShape,
  CredentialsService
} from '#/modules/credentials/services/credentials.service'
import type { CredentialStatus } from '#/modules/credentials/services/credentials.service'

import { SlidingWindowLimiter } from '../domain/sliding-window-limiter'
import { KkSellerApiClient } from './seller-api.client'

/** Too many keys were tried for this store in a short time. */
export class KkKeyAttemptsExceededError extends Error {
  constructor() {
    super('Too many attempts to set the KuantoKusta key; try again in a minute')
    this.name = 'KkKeyAttemptsExceededError'
  }
}

// Each attempt makes the hub call KuantoKusta with a key the caller chose.
// Without a cap, a stolen plugin token could be used to make the hub knock
// on that API until the hub's address is blocked for every store.
const ATTEMPTS = { limit: 5, periodMs: 60_000 }

/** Sets and describes a store's KuantoKusta Seller API key. */
@Injectable()
export class KkCredentialService {
  private readonly attempts = new Map<string, SlidingWindowLimiter>()

  constructor(
    private readonly credentials: CredentialsService,
    private readonly sellerApi: KkSellerApiClient
  ) {}

  /**
   * Stores the key, after KuantoKusta has accepted it.
   *
   * A key that cannot be verified is not stored, whether KuantoKusta refused
   * it or simply could not be reached: a wrong key saved today is a failed
   * collection found tomorrow.
   */
  async replace(
    storeId: string,
    apiKey: string,
    actor: AuditActor
  ): Promise<CredentialStatus> {
    // Checked first: a mistyped key is not sent to KuantoKusta and does not
    // use up an attempt.
    assertCredentialShape(apiKey)

    let attempts = this.attempts.get(storeId)
    if (!attempts) {
      attempts = new SlidingWindowLimiter([ATTEMPTS])
      this.attempts.set(storeId, attempts)
    }
    if (!attempts.tryAcquire()) throw new KkKeyAttemptsExceededError()

    await this.sellerApi.verifyKey(apiKey)

    return this.credentials.set(
      { storeId, provider: 'kuantokusta', secret: apiKey },
      actor
    )
  }

  status(storeId: string): Promise<CredentialStatus> {
    return this.credentials.status(storeId, 'kuantokusta')
  }

  /**
   * Whether the stored key can still be decrypted with the master keys this
   * process holds. It does not call KuantoKusta and reveals nothing.
   *
   * Worth running after any change to the master key variables: a wrong
   * master key breaks nothing visible until the next collection.
   */
  async isReadable(
    storeId: string
  ): Promise<'not_configured' | 'readable' | 'unreadable'> {
    try {
      const key = await this.credentials.revealForOutboundCall(
        storeId,
        'kuantokusta'
      )
      return key === null ? 'not_configured' : 'readable'
    } catch (error) {
      if (error instanceof CredentialDecryptionError) return 'unreadable'
      throw error
    }
  }
}
