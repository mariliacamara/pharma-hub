import { Global, Module } from '@nestjs/common'

import { env } from '#/infra/config/env'

import { PrismaService } from './prisma.service'

@Global()
@Module({
  providers: [
    {
      provide: PrismaService,
      useFactory: () => new PrismaService(env.DATABASE_URL)
    }
  ],
  exports: [PrismaService]
})
export class DatabaseModule {}
