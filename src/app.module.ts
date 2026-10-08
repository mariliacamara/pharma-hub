import { Module } from '@nestjs/common'

import { HealthModule } from './core/health/health.module'
import { DatabaseModule } from './infra/database/database.module'

@Module({
  imports: [DatabaseModule, HealthModule]
})
export class AppModule {}
