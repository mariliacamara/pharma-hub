import { Logger, Module } from '@nestjs/common'

import { env } from '#/infra/config/env'
import { PrismaService } from '#/infra/database/prisma.service'
import { ApiTokensModule } from '#/modules/api-tokens/api-tokens.module'
import { CredentialsModule } from '#/modules/credentials/credentials.module'

import { KkCredentialController } from './controllers/kk-credential.controller'
import { KkOffersController } from './controllers/kk-offers.controller'
import { KkReportController } from './controllers/kk-report.controller'
import { KkRunsController } from './controllers/kk-runs.controller'
import { KkSettingsController } from './controllers/kk-settings.controller'
import { CollectionRunsService } from './services/collection-runs.service'
import { CollectionScheduler } from './services/collection.scheduler'
import {
  CollectionService,
  DEFAULT_TIMINGS
} from './services/collection.service'
import { CollectionWorker } from './services/collection.worker'
import { KkCredentialService } from './services/kk-credential.service'
import { KkStoreSettingsService } from './services/kk-store-settings.service'
import { OffersSyncService } from './services/offers-sync.service'
import { OffersService } from './services/offers.service'
import { ProductPageClient } from './services/product-page.client'
import { ReportService } from './services/report.service'
import { KkSellerApiClient } from './services/seller-api.client'

@Module({
  imports: [ApiTokensModule, CredentialsModule],
  controllers: [
    KkCredentialController,
    KkOffersController,
    KkReportController,
    KkRunsController,
    KkSettingsController
  ],
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
    {
      provide: ProductPageClient,
      useFactory: () =>
        new ProductPageClient({
          baseUrl: env.KK_SITE_BASE_URL,
          userAgent: env.KK_COLLECTOR_USER_AGENT
        })
    },
    {
      // Built by hand because the timings are plain values, which tests
      // replace to run a whole collection in a moment.
      provide: CollectionService,
      useFactory: (
        prisma: PrismaService,
        runs: CollectionRunsService,
        offersSync: OffersSyncService,
        settings: KkStoreSettingsService,
        pages: ProductPageClient
      ) =>
        new CollectionService(
          prisma,
          runs,
          offersSync,
          settings,
          pages,
          DEFAULT_TIMINGS
        ),
      inject: [
        PrismaService,
        CollectionRunsService,
        OffersSyncService,
        KkStoreSettingsService,
        ProductPageClient
      ]
    },
    KkCredentialService,
    KkStoreSettingsService,
    OffersSyncService,
    OffersService,
    ReportService,
    CollectionRunsService,
    // Neither starts by itself: main.ts starts them, so the operator
    // commands and the tests never run a second worker by accident.
    CollectionWorker,
    CollectionScheduler
  ],
  exports: [
    KkCredentialService,
    KkStoreSettingsService,
    OffersSyncService,
    OffersService,
    CollectionRunsService,
    CollectionWorker,
    CollectionScheduler
  ]
})
export class KuantokustaModule {}
