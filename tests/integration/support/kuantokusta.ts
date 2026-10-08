import { randomBytes, randomInt } from 'node:crypto'

import type { PrismaService } from '#/infra/database/prisma.service'
import { AuditService } from '#/modules/audit/services/audit.service'
import { CredentialKeyring } from '#/modules/credentials/domain/credential-keyring'
import { CredentialsService } from '#/modules/credentials/services/credentials.service'
import { KkSellerApiClient } from '#/modules/kuantokusta/services/seller-api.client'

import { fakeOffer } from '../../support/fake-kk-server'
import type { FakeKkServer } from '../../support/fake-kk-server'

export const TEST_ACTOR = { type: 'system', label: 'integration-test' } as const

/** A client of the fake Seller API that never really waits. */
export function fakeSellerApiClient(server: FakeKkServer): KkSellerApiClient {
  return new KkSellerApiClient({
    baseUrl: server.url,
    sleep: async () => undefined,
    // The fake has no limits; the limiter is tested on its own.
    rateWindows: [{ limit: 1000, periodMs: 1000 }]
  })
}

export function testCredentials(prisma: PrismaService): CredentialsService {
  return new CredentialsService(
    prisma,
    new CredentialKeyring({ version: 1, key: randomBytes(32) }),
    new AuditService()
  )
}

/**
 * Product ids for one test file. `kk_products` is shared by every store, so
 * each file works in its own range and removes it afterwards.
 */
export class ProductRange {
  readonly base = 800_000_000 + randomInt(1, 9_000) * 10_000

  /** A real-shaped offer whose product id falls in this range. */
  offer(n: number, overrides: Record<string, unknown> = {}) {
    return fakeOffer(n, {
      productUrl: `https://www.kuantokusta.pt/p/${this.base + n}/produto-${n}`,
      ...overrides
    })
  }

  async cleanUp(prisma: PrismaService): Promise<void> {
    await prisma.kk_products.deleteMany({
      where: { external_id: { gte: this.base, lt: this.base + 10_000 } }
    })
  }
}
