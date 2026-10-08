import { Controller, Get, Logger } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'

import { PrismaService } from '#/infra/database/prisma.service'
import { ApiError } from '#/infra/http/api-error'
import { Public } from '#/modules/api-tokens/decorators/public.decorator'

interface HealthResponse {
  status: 'ok'
}

// Open on purpose: the host calls these to decide whether the service is up.
@Public()
@ApiTags('Health')
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name)

  constructor(private readonly prisma: PrismaService) {}

  /** The process is up. Used to decide whether to restart it. */
  @Get('live')
  live(): HealthResponse {
    return { status: 'ok' }
  }

  /** The process can do its job, which means it can reach the database. */
  @Get('ready')
  async ready(): Promise<HealthResponse> {
    try {
      await this.prisma.$queryRaw`SELECT 1`
      return { status: 'ok' }
    } catch (error) {
      // The cause goes to the log; the response says nothing about internals.
      this.logger.error('Readiness check failed: database unreachable', error)
      throw new ApiError(
        503,
        'database_unavailable',
        'The service cannot reach its database'
      )
    }
  }
}
