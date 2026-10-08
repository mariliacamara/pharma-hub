import { Controller, Get, Query } from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags
} from '@nestjs/swagger'
import { z } from 'zod/v4'

import { CurrentPrincipal } from '#/modules/api-tokens/decorators/current-principal.decorator'
import { RequireScopes } from '#/modules/api-tokens/decorators/require-scopes.decorator'
import type { TokenPrincipal } from '#/modules/api-tokens/domain/token-principal'

import { OffersService } from '../services/offers.service'

const MAX_PAGE_SIZE = 200

const listQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
  // The id of an offer, as returned in `nextCursor`.
  after: z
    .string()
    .regex(/^[1-9]\d{0,17}$/)
    .transform((value) => BigInt(value))
    .optional(),
  status: z.enum(['listed', 'delisted', 'all']).default('listed')
})

interface OfferResponse {
  id: string
  offerRef: string
  sku: string | null
  ean: string | null
  name: string
  storeUrl: string
  productUrl: string
  priceCents: number
  stock: number
  isTopBox: boolean
  listingStatus: 'listed' | 'delisted'
  kkUpdatedAt: string | null
  lastSeenAt: string
}

interface OffersResponse {
  offers: OfferResponse[]
  nextCursor: string | null
}

const NULLABLE_STRING = { type: ['string', 'null'] }

@ApiTags('KuantoKusta')
@ApiBearerAuth()
@Controller('v1/plugin/kuantokusta/offers')
export class KkOffersController {
  constructor(private readonly offers: OffersService) {}

  @Get()
  @RequireScopes('prices:read')
  @ApiOperation({
    summary: 'The store\'s own offers on KuantoKusta',
    description:
      'As last copied from the KuantoKusta Seller API. The plugin uses '
      + '`sku`, `ean` and `storeUrl` to link each offer to a WooCommerce '
      + 'product. Prices are integer cents. To read everything, repeat the '
      + 'call with `after` set to the `nextCursor` of the previous answer '
      + 'until it comes back null.'
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: 100 }
  })
  @ApiQuery({
    name: 'after',
    required: false,
    schema: { type: 'string' },
    description: 'The `nextCursor` of the previous page'
  })
  @ApiQuery({
    name: 'status',
    required: false,
    schema: {
      type: 'string',
      enum: ['listed', 'delisted', 'all'],
      default: 'listed'
    },
    description:
      '`delisted`: the Seller API stopped returning the offer; it is kept '
      + 'for its history'
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['offers', 'nextCursor'],
      properties: {
        nextCursor: NULLABLE_STRING,
        offers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              offerRef: { type: 'string', example: 'p-9-30068' },
              sku: NULLABLE_STRING,
              ean: NULLABLE_STRING,
              name: { type: 'string' },
              storeUrl: { type: 'string', format: 'uri' },
              productUrl: { type: 'string', format: 'uri' },
              priceCents: { type: 'integer', example: 934 },
              stock: { type: 'integer' },
              isTopBox: { type: 'boolean' },
              listingStatus: { type: 'string', enum: ['listed', 'delisted'] },
              kkUpdatedAt: { ...NULLABLE_STRING, format: 'date-time' },
              lastSeenAt: { type: 'string', format: 'date-time' }
            }
          }
        }
      }
    }
  })
  async list(
    @CurrentPrincipal() principal: TokenPrincipal,
    @Query({ schema: listQuery }) query: z.infer<typeof listQuery>
  ): Promise<OffersResponse> {
    const page = await this.offers.list(principal.storeId, query)
    return {
      nextCursor: page.nextCursor,
      offers: page.offers.map((offer) => ({
        ...offer,
        kkUpdatedAt: offer.kkUpdatedAt?.toISOString() ?? null,
        lastSeenAt: offer.lastSeenAt.toISOString()
      }))
    }
  }
}
