import { setTimeout as sleep } from 'node:timers/promises'

import { Injectable, Logger } from '@nestjs/common'
import type { OnModuleDestroy } from '@nestjs/common'

import { CollectionRunsService } from './collection-runs.service'
import { CollectionService } from './collection.service'

/**
 * Takes collection runs from the queue and carries them out, one at a time.
 *
 * One at a time for the whole hub, not per store: every store's pages are on
 * the same website, and the pause between pages is a promise made to that
 * website, not to each store.
 *
 * It runs inside the service. It is started from main.ts only, so the
 * operator commands and the tests do not start a second one by accident.
 */
const POLL_MS = 5_000
const HEARTBEAT_MS = 30_000

@Injectable()
export class CollectionWorker implements OnModuleDestroy {
  private readonly logger = new Logger(CollectionWorker.name)
  private readonly stopping = new AbortController()
  private loop: Promise<void> | null = null

  constructor(
    private readonly runs: CollectionRunsService,
    private readonly collection: CollectionService
  ) {}

  start(): void {
    if (this.loop) return
    this.logger.log('Collection worker started')
    this.loop = this.work()
  }

  /**
   * Asks the worker to stop and waits until it has put its run back.
   *
   * In the first phase of a shutdown on purpose: the database connection is
   * closed in the last one (PrismaService), so the run can still be written.
   */
  async onModuleDestroy(): Promise<void> {
    this.stopping.abort()
    await this.loop
  }

  /**
   * One round: recover abandoned runs, then carry out the next waiting run,
   * if there is one. Returns whether a run was carried out.
   */
  async tick(): Promise<boolean> {
    await this.runs.recoverAbandoned()

    const next = await this.runs.claimNext()
    if (!next) return false

    // Says "still working" on its own clock, so a long wait inside the run
    // (the Seller API being slow, for example) is not taken for a crash.
    const beat = setInterval(() => {
      this.runs.heartbeat(next).catch((error: unknown) => {
        this.logger.warn(`Heartbeat failed: ${String(error)}`)
      })
    }, HEARTBEAT_MS)
    try {
      const stopping = this.stopping.signal
      await this.collection.execute(next, {
        get stopRequested() {
          return stopping.aborted
        },
        signal: stopping
      })
    } finally {
      clearInterval(beat)
    }
    return true
  }

  private async work(): Promise<void> {
    while (!this.stopping.signal.aborted) {
      let worked = false
      try {
        worked = await this.tick()
      } catch (error) {
        // The loop must outlive any single failure: the database being
        // away for a minute should not end collections for good.
        this.logger.error(
          'Collection worker round failed',
          error instanceof Error ? error.stack : String(error)
        )
      }
      if (worked) continue
      try {
        await sleep(POLL_MS, undefined, { signal: this.stopping.signal })
      } catch {
        // Stopping: the wait was cut short.
      }
    }
    this.logger.log('Collection worker stopped')
  }
}
