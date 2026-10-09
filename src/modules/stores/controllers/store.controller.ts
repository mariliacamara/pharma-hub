import { Controller, Get } from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags
} from '@nestjs/swagger'

import { ApiError } from '#/infra/http/api-error'
import { CurrentPrincipal } from '#/modules/api-tokens/decorators/current-principal.decorator'
import { RequireScopes } from '#/modules/api-tokens/decorators/require-scopes.decorator'
import type { TokenPrincipal } from '#/modules/api-tokens/domain/token-principal'

import { StoresService } from '../services/stores.service'

interface StoreResponse {
  name: string
  brandName: string
}

@ApiTags('Store')
@ApiBearerAuth()
@Controller('v1/plugin/store')
export class StoreController {
  constructor(private readonly stores: StoresService) {}

  @Get()
  @RequireScopes('prices:read')
  @ApiOperation({
    summary: 'The store the token belongs to',
    description:
      '`brandName` is the product name to show in the plugin, for example '
      + '"ZincoGroup Hub" (decision 0014). The technical name of the hub is '
      + 'never shown to a client. No id is returned: the plugin never names '
      + 'a store, the token does.'
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['name', 'brandName'],
      properties: {
        name: { type: 'string', example: 'Zincomed' },
        brandName: { type: 'string', example: 'ZincoGroup Hub' }
      }
    }
  })
  async get(
    @CurrentPrincipal() principal: TokenPrincipal
  ): Promise<StoreResponse> {
    const store = await this.stores.findById(principal.storeId)
    // The token was just resolved to this store, and a store's tokens are
    // deleted with it, so this only happens if it was deleted in between.
    if (!store) throw new ApiError(401, 'invalid_token', 'The token is not valid')
    return { name: store.name, brandName: store.brandName }
  }
}
