import {
  Body,
  Controller,
  Get,
  HttpCode,
  Put
} from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags
} from '@nestjs/swagger'
import { z } from 'zod/v4'

import { CurrentPrincipal } from '#/modules/api-tokens/decorators/current-principal.decorator'
import { RequireScopes } from '#/modules/api-tokens/decorators/require-scopes.decorator'
import type { TokenPrincipal } from '#/modules/api-tokens/domain/token-principal'

import { toApiError } from '../kuantokusta.errors'
import { KkCredentialService } from '../services/kk-credential.service'

const replaceBody = z.strictObject({
  apiKey: z.string().min(1).max(512)
})

const STATUS_SCHEMA = {
  type: 'object',
  required: ['provider', 'configured', 'lastFour', 'updatedAt'],
  properties: {
    provider: { type: 'string', enum: ['kuantokusta'] },
    configured: { type: 'boolean' },
    lastFour: {
      type: ['string', 'null'],
      description: 'The last four characters of the stored key',
      example: 'a1b2'
    },
    updatedAt: { type: ['string', 'null'], format: 'date-time' }
  }
}

interface CredentialStatusResponse {
  provider: 'kuantokusta'
  configured: boolean
  lastFour: string | null
  updatedAt: string | null
}

@ApiTags('KuantoKusta')
@ApiBearerAuth()
@Controller('v1/plugin/kuantokusta/credential')
export class KkCredentialController {
  constructor(private readonly credential: KkCredentialService) {}

  @Put()
  @HttpCode(200)
  @RequireScopes('credentials:write')
  @ApiOperation({
    summary: 'Set the store\'s KuantoKusta Seller API key',
    description:
      'The key is checked against KuantoKusta first and stored encrypted '
      + 'only if it is accepted. It replaces any key stored before. No route '
      + 'ever returns the key.'
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['apiKey'],
      additionalProperties: false,
      properties: { apiKey: { type: 'string', writeOnly: true } }
    }
  })
  @ApiOkResponse({ schema: STATUS_SCHEMA })
  @ApiResponse({ status: 422, description: '`kk_key_rejected`' })
  @ApiResponse({
    status: 503,
    description: '`kk_unavailable` or `kk_rate_limited`; nothing was stored'
  })
  async replace(
    @CurrentPrincipal() principal: TokenPrincipal,
    @Body({ schema: replaceBody }) body: z.infer<typeof replaceBody>
  ): Promise<CredentialStatusResponse> {
    try {
      const status = await this.credential.replace(
        principal.storeId,
        body.apiKey.trim(),
        {
          type: 'api_token',
          tokenId: principal.tokenId,
          tokenPrefix: principal.tokenPrefix
        }
      )
      return present(status)
    } catch (error) {
      throw toApiError(error)
    }
  }

  @Get()
  @RequireScopes('prices:read')
  @ApiOperation({
    summary: 'Whether the store has a KuantoKusta key configured',
    description: 'Shows the last four characters at most, never the key.'
  })
  @ApiOkResponse({ schema: STATUS_SCHEMA })
  async status(
    @CurrentPrincipal() principal: TokenPrincipal
  ): Promise<CredentialStatusResponse> {
    return present(await this.credential.status(principal.storeId))
  }
}

function present(status: {
  configured: boolean
  lastFour: string | null
  updatedAt: Date | null
}): CredentialStatusResponse {
  return {
    provider: 'kuantokusta',
    configured: status.configured,
    lastFour: status.lastFour,
    updatedAt: status.updatedAt?.toISOString() ?? null
  }
}
