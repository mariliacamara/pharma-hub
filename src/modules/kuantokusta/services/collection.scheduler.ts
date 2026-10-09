import { setTimeout as sleep } from 'node:timers/promises'

import { Injectable, Logger } from '@nestjs/common'
import type { OnModuleDestroy } from '@nestjs/common'

import { PrismaService } from '#/infra/database/prisma.service'

import { isDailyRunDue } from '../domain/daily-schedule'
import { CollectionRunsService } from './collection-runs.service'
import { KkCredentialService } from './kk-credential.service'

/**
 * Asks for one collection per store per day, at a set time in Portugal.
 *
 * Off unless `KK_COLLECTION_DAILY_AT` is set. It only puts runs in the
 * queue; the worker carries them out.
 */
const CHECK_EVERY_MS = 60_000
const SCHEDULER = { type: 'system', label: 'scheduler' } as const

@Injectable()
export class CollectionScheduler implements OnModuleDestroy {
  private readonly logger = new Logger(CollectionScheduler.name)
  private readonly stopping = new AbortController()
  private loop: Promise<void> | null = null

  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: CollectionRunsService,
    private readonly credential: KkCredentialService
  ) {}

  /** `dailyAt` is HH:MM in Portugal time; undefined leaves it off. */
  start(dailyAt: string | undefined): void {
    if (this.loop) return
    if (!dailyAt) {
      this.logger.log('Daily collection is off (KK_COLLECTION_DAILY_AT not set)')
      return
    }
    this.logger.log(`Daily collection at ${dailyAt}, Portugal time`)
    this.loop = this.watch(dailyAt)
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping.abort()
    await this.loop
  }

  /** Asks for today's run of every store that is due. Returns how many. */
  async tick(dailyAt: string, now: Date = new Date()): Promise<number> {
    const stores = await this.prisma.stores.findMany({
      select: { id: true },
      take: 500
    })

    let requested = 0
    for (const { id } of stores) {
      try {
        const last = await this.runs.lastScheduledAt(id)
        if (!isDailyRunDue(now, dailyAt, last)) continue
        // A store without a key has nothing to collect yet.
        if (!(await this.credential.status(id)).configured) continue

        const { created } = await this.runs.request(
          id,
          { trigger: 'schedule' },
          SCHEDULER
        )
        if (created) requested++
      } catch (error) {
        // One store's problem must not cost the others their collection.
        this.logger.error(
          `Could not schedule the collection of store=${id}`,
          error instanceof Error ? error.stack : String(error)
        )
      }
    }
    return requested
  }

  private async watch(dailyAt: string): Promise<void> {
    while (!this.stopping.signal.aborted) {
      try {
        const requested = await this.tick(dailyAt)
        if (requested > 0) {
          this.logger.log(`Scheduled ${requested} collection(s)`)
        }
      } catch (error) {
        this.logger.error(
          'Scheduler round failed',
          error instanceof Error ? error.stack : String(error)
        )
      }
      try {
        await sleep(CHECK_EVERY_MS, undefined, { signal: this.stopping.signal })
      } catch {
        // Stopping.
      }
    }
  }
}
