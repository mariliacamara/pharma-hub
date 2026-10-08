import {
  Controller,
  Get,
  Logger,
  ServiceUnavailableException
} from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'

import { PrismaService } from '#/infra/database/prisma.service'

interface HealthResponse {
  status: 'ok'
}

@ApiTags('health')
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
      throw new ServiceUnavailableException({ status: 'unavailable' })
    }
  }
}
