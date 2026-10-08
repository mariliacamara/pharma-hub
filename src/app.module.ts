import { Module, StandardSchemaValidationPipe } from '@nestjs/common'
import type { MiddlewareConsumer, NestModule } from '@nestjs/common'
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core'

import { ApiError } from './infra/http/api-error'
import { ApiExceptionFilter } from './infra/http/api-exception.filter'
import { RequestContextMiddleware } from './infra/http/request-context.middleware'
import { DatabaseModule } from './infra/database/database.module'
import { ApiTokensModule } from './modules/api-tokens/api-tokens.module'
import { ApiTokenGuard } from './modules/api-tokens/guards/api-token.guard'
import { AuditModule } from './modules/audit/audit.module'
import { CredentialsModule } from './modules/credentials/credentials.module'
import { HealthModule } from './modules/health/health.module'
import { KuantokustaModule } from './modules/kuantokusta/kuantokusta.module'
import { StoresModule } from './modules/stores/stores.module'

@Module({
  imports: [
    DatabaseModule,
    AuditModule,
    HealthModule,
    StoresModule,
    ApiTokensModule,
    CredentialsModule,
    KuantokustaModule
  ],
  providers: [
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    // Closed by default: a route answers without a token only if it is
    // marked @Public(). See ApiTokenGuard.
    { provide: APP_GUARD, useExisting: ApiTokenGuard },
    {
      provide: APP_PIPE,
      useFactory: () =>
        new StandardSchemaValidationPipe({
          // Says which field is wrong and why, never what was sent.
          exceptionFactory: (issues) =>
            new ApiError(
              400,
              'invalid_request',
              issues
                .map((issue) => {
                  const path = (issue.path ?? [])
                    .map((part) =>
                      String(typeof part === 'object' ? part.key : part)
                    )
                    .join('.')
                  return path ? `${path}: ${issue.message}` : issue.message
                })
                .join('; ')
            )
        })
    }
  ]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('{*path}')
  }
}
