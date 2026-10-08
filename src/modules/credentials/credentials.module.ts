import { Module } from '@nestjs/common'

import { env } from '#/infra/config/env'

import { CredentialKeyring } from './domain/credential-keyring'
import { CredentialsService } from './services/credentials.service'

@Module({
  providers: [
    {
      provide: CredentialKeyring,
      useFactory: () =>
        new CredentialKeyring(
          env.CREDENTIALS_MASTER_KEY,
          env.CREDENTIALS_PREVIOUS_KEYS
        )
    },
    CredentialsService
  ],
  exports: [CredentialsService]
})
export class CredentialsModule {}
