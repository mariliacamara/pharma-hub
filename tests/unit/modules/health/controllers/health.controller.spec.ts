import { describe, beforeAll, it, expect } from '@jest/globals'
import { Logger, ServiceUnavailableException } from '@nestjs/common'

import { HealthController } from '#/modules/health/controllers/health.controller'
import type { PrismaService } from '#/infra/database/prisma.service'

function controllerWith(queryRaw: () => Promise<unknown>): HealthController {
  return new HealthController({
    $queryRaw: queryRaw
  } as unknown as PrismaService)
}

describe('HealthController', () => {
  beforeAll(() => {
    // The failure below is logged on purpose; keep it out of the test output.
    Logger.overrideLogger(false)
  })

  it('reports live without touching the database', () => {
    const controller = controllerWith(async () => {
      throw new Error('must not be called')
    })

    expect(controller.live()).toEqual({ status: 'ok' })
  })

  it('reports ready when the database answers', async () => {
    const controller = controllerWith(async () => [{ ok: 1 }])

    await expect(controller.ready()).resolves.toEqual({ status: 'ok' })
  })

  it('answers 503 without leaking the cause when the database is unreachable', async () => {
    const controller = controllerWith(async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2')
    })
    const error = await controller.ready().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ServiceUnavailableException)
    expect(
      JSON.stringify((error as ServiceUnavailableException).getResponse())
    ).toBe('{"status":"unavailable"}')
  })
})
