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
import type { ComparisonCounts } from '../services/collection-runs.service'
import { KkCredentialService } from '../services/kk-credential.service'
import { presentRun, RUN_SCHEMA } from './run-response'
import type { RunResponse } from './run-response'

const requestBody = z
  .strictObject({
    // Who pressed the button, as the plugin knows them: a WordPress login,
    // for example. Kept for the history; it grants nothing.
    requestedBy: z
      .string()
      .trim()
      .min(1)
      .max(120)
      // One line of text: it is shown later in a terminal and in the panel.
      .regex(/^\P{Cc}+$/u, 'must not contain control characters')
      .optional()
  })
  .default({})

const listQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(10)
})

const runParams = z.strictObject({ id: z.uuid() })

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
      return { run: presentRun(run), created }
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
    return { runs: runs.map(presentRun) }
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
      run: presentRun(run),
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
      run: presentRun(run),
      summary: await this.runs.summary(principal.storeId, run.id)
    }
  }
}
