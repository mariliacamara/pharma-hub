import { Module } from '@nestjs/common'

import { ApiTokenGuard } from './guards/api-token.guard'
import { ApiTokensService } from './services/api-tokens.service'

@Module({
  providers: [ApiTokensService, ApiTokenGuard],
  exports: [ApiTokensService, ApiTokenGuard]
})
export class ApiTokensModule {}
