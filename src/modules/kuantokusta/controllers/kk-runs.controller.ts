import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query
} from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiBody,
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

import { toApiError } from '../kuantokusta.errors'
import { CollectionRunsService } from '../services/collection-runs.service'
import type {
  ComparisonCounts,
  RunView
} from '../services/collection-runs.service'
import { KkCredentialService } from '../services/kk-credential.service'

const requestBody = z
  .strictObject({
    // Who pressed the button, as the plugin knows them: a WordPress login,
    // for example. Kept for the history; it grants nothing.
    requestedBy: z.string().trim().min(1).max(120).optional()
  })
  .default({})

const listQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(10)
})

const runParams = z.strictObject({ id: z.uuid() })

interface RunResponse {
  id: string
  status: RunView['status']
  trigger: RunView['trigger']
  requestedBy: string | null
  progress: { total: number, read: number, notRead: number }
  errorCode: string | null
  queuedAt: string
  startedAt: string | null
  finishedAt: string | null
}

const NULLABLE_STRING = { type: ['string', 'null'] }

const RUN_SCHEMA = {
  type: 'object',
  required: [
    'id',
    'status',
    'trigger',
    'requestedBy',
    'progress',
    'errorCode',
    'queuedAt',
    'startedAt',
    'finishedAt'
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    status: {
      type: 'string',
      enum: ['queued', 'running', 'succeeded', 'partial', 'failed', 'blocked'],
      description:
        '`queued` and `running`: not finished yet, ask again later. '
        + '`succeeded`: every product page was read. `partial`: some pages '
        + 'could not be read; the others were compared. `blocked`: the '
        + 'KuantoKusta website refused the hub and the collection stopped. '
        + '`failed`: see `errorCode`.'
    },
    trigger: { type: 'string', enum: ['schedule', 'manual'] },
    requestedBy: NULLABLE_STRING,
    progress: {
      type: 'object',
      description: 'Product pages: to read, read, and not read',
      properties: {
        total: { type: 'integer' },
        read: { type: 'integer' },
        notRead: { type: 'integer' }
      }
    },
    errorCode: {
      ...NULLABLE_STRING,
      description:
        'Set when the status is `failed` or `blocked`. For example '
        + '`kk_key_missing`, `kk_key_rejected`, `kk_unavailable`, '
        + '`blocked_by_site`, `robots_refused`, `store_identity_unknown`, '
        + '`abandoned`, `internal_error`.',
      example: null
    },
    queuedAt: { type: 'string', format: 'date-time' },
    startedAt: { ...NULLABLE_STRING, format: 'date-time' },
    finishedAt: { ...NULLABLE_STRING, format: 'date-time' }
  }
}

const SUMMARY_SCHEMA = {
  type: 'object',
  description:
    'How many of the store\'s offers ended in each situation. All zero '
    + 'while the run has not compared anything yet.',
  properties: {
    cheapest: { type: 'integer' },
    tied: { type: 'integer' },
    more_expensive: { type: 'integer' },
    only_store: { type: 'integer' },
    no_data: { type: 'integer' }
  }
}

const RUN_WITH_SUMMARY = {
  type: 'object',
  required: ['run', 'summary'],
  properties: { run: RUN_SCHEMA, summary: SUMMARY_SCHEMA }
}

@ApiTags('KuantoKusta')
@ApiBearerAuth()
@Controller('v1/plugin/kuantokusta/runs')
export class KkRunsController {
  constructor(
    private readonly runs: CollectionRunsService,
    private readonly credential: KkCredentialService
  ) {}

  @Post()
  @HttpCode(202)
  @RequireScopes('prices:refresh')
  @ApiOperation({
    summary: 'Ask for a new collection of competitor prices',
    description:
      'Answers at once; the collection itself takes minutes (one product '
      + 'page every few seconds). Follow it with `GET /runs/{id}`. If a '
      + 'collection of the store is already waiting or running, that one is '
      + 'returned and `created` is false: asking twice never starts two.'
  })
  @ApiBody({
    required: false,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        requestedBy: {
          type: 'string',
          maxLength: 120,
          description: 'Who asked, for the history. For example a login name.'
        }
      }
    }
  })
  @ApiResponse({
    status: 202,
    schema: {
      type: 'object',
      required: ['run', 'created'],
      properties: { run: RUN_SCHEMA, created: { type: 'boolean' } }
    }
  })
  @ApiResponse({
    status: 409,
    description: '`kk_key_missing`: the store has no KuantoKusta key yet'
  })
  @ApiResponse({
    status: 429,
    description:
      '`kk_run_too_soon`: a collection finished a moment ago. The '
      + '`Retry-After` header says how many seconds to wait.'
  })
  async request(
    @CurrentPrincipal() principal: TokenPrincipal,
    @Body({ schema: requestBody }) body: z.infer<typeof requestBody>
  ): Promise<{ run: RunResponse, created: boolean }> {
    // Said now, rather than by a run that fails a few seconds later.
    const { configured } = await this.credential.status(principal.storeId)
    if (!configured) {
      throw new ApiError(
        409,
        'kk_key_missing',
        'The store has no KuantoKusta API key configured'
      )
    }

    try {
      const { run, created } = await this.runs.request(
        principal.storeId,
        {
          trigger: 'manual',
          requestedBy: body.requestedBy ?? `token ${principal.tokenPrefix}`
        },
        {
          type: 'api_token',
          tokenId: principal.tokenId,
          tokenPrefix: principal.tokenPrefix
        }
      )
      return { run: present(run), created }
    } catch (error) {
      throw toApiError(error)
    }
  }

  @Get()
  @RequireScopes('prices:read')
  @ApiOperation({ summary: 'The store\'s latest collections, newest first' })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 50, default: 10 }
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['runs'],
      properties: { runs: { type: 'array', items: RUN_SCHEMA } }
    }
  })
  async list(
    @CurrentPrincipal() principal: TokenPrincipal,
    @Query({ schema: listQuery }) query: z.infer<typeof listQuery>
  ): Promise<{ runs: RunResponse[] }> {
    const runs = await this.runs.list(principal.storeId, query.limit)
    return { runs: runs.map(present) }
  }

  @Get('latest')
  @RequireScopes('prices:read')
  @ApiOperation({
    summary: 'The store\'s most recent collection',
    description: '`run` is null when the store never had one.'
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['run', 'summary'],
      properties: {
        run: { oneOf: [RUN_SCHEMA, { type: 'null' }] },
        summary: { oneOf: [SUMMARY_SCHEMA, { type: 'null' }] }
      }
    }
  })
  async latest(
    @CurrentPrincipal() principal: TokenPrincipal
  ): Promise<{ run: RunResponse | null, summary: ComparisonCounts | null }> {
    const run = await this.runs.latest(principal.storeId)
    if (!run) return { run: null, summary: null }
    return {
      run: present(run),
      summary: await this.runs.summary(principal.storeId, run.id)
    }
  }

  @Get(':id')
  @RequireScopes('prices:read')
  @ApiOperation({
    summary: 'One collection: how far it is and how it ended'
  })
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ schema: RUN_WITH_SUMMARY })
  @ApiResponse({ status: 404, description: '`kk_run_not_found`' })
  async get(
    @CurrentPrincipal() principal: TokenPrincipal,
    @Param({ schema: runParams }) params: z.infer<typeof runParams>
  ): Promise<{ run: RunResponse, summary: ComparisonCounts }> {
    // Looked up inside the caller's store: another store's run is simply
    // not there.
    const run = await this.runs.get(principal.storeId, params.id)
    if (!run) {
      throw new ApiError(404, 'kk_run_not_found', 'There is no such collection')
    }
    return {
      run: present(run),
      summary: await this.runs.summary(principal.storeId, run.id)
    }
  }
}

function present(run: RunView): RunResponse {
  return {
    id: run.id,
    status: run.status,
    trigger: run.trigger,
    requestedBy: run.requestedBy,
    progress: {
      total: run.itemsTotal,
      read: run.itemsOk,
      notRead: run.itemsFailed
    },
    errorCode: run.errorCode,
    queuedAt: run.queuedAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null
  }
}
