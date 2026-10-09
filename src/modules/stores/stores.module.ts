import { Module } from '@nestjs/common'

import { StoreController } from './controllers/store.controller'
import { StoresService } from './services/stores.service'

@Module({
  controllers: [StoreController],
  providers: [StoresService],
  exports: [StoresService]
})
export class StoresModule {}
