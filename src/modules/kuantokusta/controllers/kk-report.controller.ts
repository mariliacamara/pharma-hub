import { Controller, Get, Param, Query } from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags
} from '@nestjs/swagger'
import { z } from 'zod/v4'

import { ApiError } from '#/infra/http/api-error'
import { CurrentPrincipal } from '#/modules/api-tokens/decorators/current-principal.decorator'
import { RequireScopes } from '#/modules/api-tokens/decorators/require-scopes.decorator'
import type { TokenPrincipal } from '#/modules/api-tokens/domain/token-principal'

import { ReportService } from '../services/report.service'
import type {
  HistoryEntry,
  ReportRow,
  ReportSummary
} from '../services/report.service'
import { NULLABLE_STRING, presentRun, RUN_SCHEMA } from './run-response'
import type { RunResponse } from './run-response'

const MAX_PAGE_SIZE = 200
const OUTCOMES = ['cheapest', 'tied', 'more_expensive', 'only_store', 'no_data'] as const
const STATES = ['active', 'out_of_stock', 'delisted', 'all'] as const

// An id of the hub, as returned in `offerId`, `id` and `nextCursor`.
const hubId = z
  .string()
  .regex(/^[1-9]\d{0,17}$/)
  .transform((value) => BigInt(value))

const reportQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
  after: hubId.optional(),
  state: z.enum(STATES).default('active'),
  outcome: z.enum(OUTCOMES).optional(),
  easyAdjust: z.stringbool().optional(),
  checkLink: z.stringbool().optional()
})

const historyParams = z.strictObject({ id: hubId })

const historyQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  before: hubId.optional()
})

type ReportRowResponse = Omit<ReportRow, 'comparedAt'> & { comparedAt: string }

interface ReportResponse {
  run: RunResponse | null
  easyAdjustCents: number
  checkLinkPercent: number
  summary: ReportSummary
  rows: ReportRowResponse[]
  nextCursor: string | null
}

type HistoryEntryResponse = Omit<HistoryEntry, 'comparedAt'> & { comparedAt: string }

interface HistoryResponse {
  entries: HistoryEntryResponse[]
  nextCursor: string | null
}

const NULLABLE_INTEGER = { type: ['integer', 'null'] }
const NULLABLE_NUMBER = { type: ['number', 'null'] }

const ROW_SCHEMA = {
  type: 'object',
  properties: {
    offerId: { type: 'string', description: 'The offer in the hub; `id` of `GET /offers`' },
    offerRef: { type: 'string', example: 'p-9-30068' },
    sku: NULLABLE_STRING,
    ean: NULLABLE_STRING,
    name: { type: 'string' },
    storeUrl: { type: 'string', format: 'uri' },
    productUrl: { type: 'string', format: 'uri' },
    offerState: {
      type: 'string',
      enum: ['active', 'out_of_stock', 'delisted'],
      description:
        'Where the offer stands in the latest copy of the store\'s offers. '
        + 'Only `active` offers are compared by a collection, so the others '
        + 'show their last comparison from before.'
    },
    runId: { type: 'string', format: 'uuid' },
    comparedAt: { type: 'string', format: 'date-time' },
    stale: {
      type: 'boolean',
      description:
        'The comparison is older than the most recent collection: that '
        + 'collection did not reach this offer'
    },
    outcome: { type: 'string', enum: [...OUTCOMES] },
    storePriceCents: { type: 'integer', example: 1599 },
    storeIsListed: { type: ['boolean', 'null'] },
    lowestPriceCents: NULLABLE_INTEGER,
    lowestStoreName: NULLABLE_STRING,
    differenceCents: {
      ...NULLABLE_INTEGER,
      description: 'Store price minus lowest price. Positive: the store is more expensive'
    },
    differencePercent: {
      ...NULLABLE_NUMBER,
      description: 'The difference against the higher of the two prices, between -100 and 100'
    },
    easyAdjust: {
      type: 'boolean',
      description: 'More expensive by at most `easyAdjustCents`'
    },
    checkLink: {
      type: 'boolean',
      description:
        'The difference is `checkLinkPercent` or more, either way: check that '
        + 'the KuantoKusta page is really this product before acting'
    },
    storePosition: NULLABLE_INTEGER,
    storeCount: NULLABLE_INTEGER,
    storeTotalCents: { ...NULLABLE_INTEGER, description: 'With the minimum shipping' },
    lowestTotalCents: NULLABLE_INTEGER,
    lowestTotalStoreName: NULLABLE_STRING,
    totalDifferenceCents: NULLABLE_INTEGER
  }
}

const SUMMARY_SCHEMA = {
  type: 'object',
  description:
    'Over every offer in the chosen `state`, whatever the other filters',
  properties: Object.fromEntries(
    ['offers', ...OUTCOMES, 'easyAdjust', 'checkLink', 'stale'].map((key) => [
      key,
      { type: 'integer' }
    ])
  )
}

const HISTORY_ENTRY_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    runId: { type: 'string', format: 'uuid' },
    comparedAt: { type: 'string', format: 'date-time' },
    outcome: { type: 'string', enum: [...OUTCOMES] },
    storePriceCents: { type: 'integer' },
    lowestPriceCents: NULLABLE_INTEGER,
    lowestStoreName: NULLABLE_STRING,
    differenceCents: NULLABLE_INTEGER,
    differencePercent: NULLABLE_NUMBER,
    storePosition: NULLABLE_INTEGER,
    storeCount: NULLABLE_INTEGER,
    storeTotalCents: NULLABLE_INTEGER,
    lowestTotalCents: NULLABLE_INTEGER
  }
}

@ApiTags('KuantoKusta')
@ApiBearerAuth()
@Controller('v1/plugin/kuantokusta')
export class KkReportController {
  constructor(private readonly report: ReportService) {}

  @Get('report')
  @RequireScopes('prices:read')
  @ApiOperation({
    summary: 'The price report: the latest comparison of each offer',
    description:
      'One row per offer, with its most recent comparison, even when the '
      + 'latest collection did not reach it (then `stale` is true). Offers '
      + 'never compared are not listed. Prices are integer cents; percentage, '
      + '`easyAdjust` and `checkLink` are worked out on every read. `run` is '
      + 'the most recent collection that ended, null when there was none. '
      + 'To read everything, repeat the call with `after` set to the '
      + '`nextCursor` of the previous answer until it comes back null.'
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: 100 }
  })
  @ApiQuery({ name: 'after', required: false, schema: { type: 'string' } })
  @ApiQuery({
    name: 'state',
    required: false,
    schema: { type: 'string', enum: [...STATES], default: 'active' },
    description: '`active`: listed and in stock, the offers a collection compares'
  })
  @ApiQuery({ name: 'outcome', required: false, schema: { type: 'string', enum: [...OUTCOMES] } })
  @ApiQuery({ name: 'easyAdjust', required: false, schema: { type: 'boolean' } })
  @ApiQuery({ name: 'checkLink', required: false, schema: { type: 'boolean' } })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: [
        'run',
        'easyAdjustCents',
        'checkLinkPercent',
        'summary',
        'rows',
        'nextCursor'
      ],
      properties: {
        run: { oneOf: [RUN_SCHEMA, { type: 'null' }] },
        easyAdjustCents: { type: 'integer', example: 10 },
        checkLinkPercent: { type: 'integer', example: 50 },
        summary: SUMMARY_SCHEMA,
        rows: { type: 'array', items: ROW_SCHEMA },
        nextCursor: NULLABLE_STRING
      }
    }
  })
  async get(
    @CurrentPrincipal() principal: TokenPrincipal,
    @Query({ schema: reportQuery }) query: z.infer<typeof reportQuery>
  ): Promise<ReportResponse> {
    const report = await this.report.report(principal.storeId, query)
    return {
      run: report.run ? presentRun(report.run) : null,
      easyAdjustCents: report.easyAdjustCents,
      checkLinkPercent: report.checkLinkPercent,
      summary: report.summary,
      rows: report.rows.map((row) => ({
        ...row,
        comparedAt: row.comparedAt.toISOString()
      })),
      nextCursor: report.nextCursor
    }
  }

  @Get('offers/:id/history')
  @RequireScopes('prices:read')
  @ApiOperation({
    summary: 'Every comparison of one offer, newest first',
    description:
      'For a price chart. Repeat with `before` set to `nextCursor` to go '
      + 'further back.'
  })
  @ApiParam({ name: 'id', schema: { type: 'string' }, description: 'The `offerId`' })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: 50 }
  })
  @ApiQuery({ name: 'before', required: false, schema: { type: 'string' } })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['entries', 'nextCursor'],
      properties: {
        entries: { type: 'array', items: HISTORY_ENTRY_SCHEMA },
        nextCursor: NULLABLE_STRING
      }
    }
  })
  @ApiResponse({ status: 404, description: '`kk_offer_not_found`' })
  async history(
    @CurrentPrincipal() principal: TokenPrincipal,
    @Param({ schema: historyParams }) params: z.infer<typeof historyParams>,
    @Query({ schema: historyQuery }) query: z.infer<typeof historyQuery>
  ): Promise<HistoryResponse> {
    // Looked up inside the caller's store: another store's offer is simply
    // not there.
    const history = await this.report.history(principal.storeId, params.id, query)
    if (!history) {
      throw new ApiError(404, 'kk_offer_not_found', 'There is no such offer')
    }
    return {
      entries: history.entries.map((entry) => ({
        ...entry,
        comparedAt: entry.comparedAt.toISOString()
      })),
      nextCursor: history.nextCursor
    }
  }
}
