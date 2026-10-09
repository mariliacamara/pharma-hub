import { Body, Controller, Get, HttpCode, Put } from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags
} from '@nestjs/swagger'
import { z } from 'zod/v4'

import { CurrentPrincipal } from '#/modules/api-tokens/decorators/current-principal.decorator'
import { RequireScopes } from '#/modules/api-tokens/decorators/require-scopes.decorator'
import type { TokenPrincipal } from '#/modules/api-tokens/domain/token-principal'

import { toApiError } from '../kuantokusta.errors'
import {
  DEFAULT_EASY_ADJUST_CENTS,
  KkStoreSettingsService,
  MAX_EASY_ADJUST_CENTS
} from '../services/kk-store-settings.service'

const easyAdjustBody = z.strictObject({
  cents: z.number().int().min(0).max(MAX_EASY_ADJUST_CENTS)
})

interface EasyAdjustResponse {
  cents: number
}

const EASY_ADJUST_SCHEMA = {
  type: 'object',
  required: ['cents'],
  properties: {
    cents: {
      type: 'integer',
      minimum: 0,
      maximum: MAX_EASY_ADJUST_CENTS,
      example: DEFAULT_EASY_ADJUST_CENTS,
      description:
        'An offer is an "easy adjust" when the store is more expensive by at '
        + 'most this many cents'
    }
  }
}

@ApiTags('KuantoKusta')
@ApiBearerAuth()
@Controller('v1/plugin/kuantokusta/settings')
export class KkSettingsController {
  constructor(private readonly settings: KkStoreSettingsService) {}

  @Get('easy-adjust')
  @RequireScopes('prices:read')
  @ApiOperation({ summary: 'The store\'s "easy adjust" threshold' })
  @ApiOkResponse({ schema: EASY_ADJUST_SCHEMA })
  async getEasyAdjust(
    @CurrentPrincipal() principal: TokenPrincipal
  ): Promise<EasyAdjustResponse> {
    const settings = await this.settings.get(principal.storeId)
    return { cents: settings?.easyAdjustCents ?? DEFAULT_EASY_ADJUST_CENTS }
  }

  @Put('easy-adjust')
  @HttpCode(200)
  // The same scope as asking for a collection: both are what a store's
  // operator does with the report (decision 0029).
  @RequireScopes('prices:refresh')
  @ApiOperation({
    summary: 'Change the store\'s "easy adjust" threshold',
    description:
      'Takes effect on the next read of the report; nothing is recalculated. '
      + 'It can be set before the store\'s first collection. Recorded in the '
      + 'audit log.'
  })
  @ApiBody({ schema: { ...EASY_ADJUST_SCHEMA, additionalProperties: false } })
  @ApiOkResponse({ schema: EASY_ADJUST_SCHEMA })
  async setEasyAdjust(
    @CurrentPrincipal() principal: TokenPrincipal,
    @Body({ schema: easyAdjustBody }) body: z.infer<typeof easyAdjustBody>
  ): Promise<EasyAdjustResponse> {
    try {
      await this.settings.setEasyAdjust(principal.storeId, body.cents, {
        type: 'api_token',
        tokenId: principal.tokenId,
        tokenPrefix: principal.tokenPrefix
      })
    } catch (error) {
      throw toApiError(error)
    }
    return { cents: body.cents }
  }
}
