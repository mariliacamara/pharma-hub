import { Logger, Module } from '@nestjs/common'

import { env } from '#/infra/config/env'
import { ApiTokensModule } from '#/modules/api-tokens/api-tokens.module'
import { CredentialsModule } from '#/modules/credentials/credentials.module'

import { KkCredentialController } from './controllers/kk-credential.controller'
import { KkOffersController } from './controllers/kk-offers.controller'
import { KkCredentialService } from './services/kk-credential.service'
import { OffersSyncService } from './services/offers-sync.service'
import { OffersService } from './services/offers.service'
import { KkSellerApiClient } from './services/seller-api.client'

@Module({
  imports: [ApiTokensModule, CredentialsModule],
  controllers: [KkCredentialController, KkOffersController],
  providers: [
    {
      provide: KkSellerApiClient,
      useFactory: () => {
        // Said once at start: production and sandbox answer alike, and a
        // sync against the wrong one is hard to spot afterwards.
        Logger.log(
          `Seller API at ${new URL(env.KK_SELLER_API_BASE_URL).host}`,
          KuantokustaModule.name
        )
        return new KkSellerApiClient({ baseUrl: env.KK_SELLER_API_BASE_URL })
      }
    },
    KkCredentialService,
    OffersSyncService,
    OffersService
  ],
  exports: [KkCredentialService, OffersSyncService, OffersService]
})
export class KuantokustaModule {}
