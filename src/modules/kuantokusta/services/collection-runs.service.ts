import { Injectable, Logger } from '@nestjs/common'

import { isUniqueViolation } from '#/infra/database/prisma-errors'
import { PrismaService } from '#/infra/database/prisma.service'
import { uuidV7 } from '#/infra/ids/uuid-v7'
import { AuditService } from '#/modules/audit/services/audit.service'
import type { AuditActor } from '#/modules/audit/services/audit.service'

/**
 * The collection runs of the KuantoKusta module: asking for one, following
 * it, and the bookkeeping the worker needs.
 *
 * A run is a row in `job_runs`. The row is the queue entry, the progress
 * report and the history at once, so nothing else has to be kept in step
 * with it.
 */
export const FULL_COLLECTION = 'kk_full_collection'

export type RunStatus
  = | 'queued'
    | 'running'
    | 'succeeded'
    | 'partial'
    | 'failed'
    | 'blocked'

export type ComparisonCounts = Record<
  'cheapest' | 'tied' | 'more_expensive' | 'only_store' | 'no_data',
  number
>

export interface RunView {
  id: string
  status: RunStatus
  trigger: 'schedule' | 'manual'
  /** Who asked for it, as reported by the caller. Null for scheduled runs. */
  requestedBy: string | null
  /** Product pages to read, read successfully, and not read. */
  itemsTotal: number
  itemsOk: number
  itemsFailed: number
  /** Why it failed or was blocked. Null otherwise. */
  errorCode: string | null
  queuedAt: Date
  startedAt: Date | null
  finishedAt: Date | null
}

/** A run finished so recently that another one would only repeat it. */
export class RunTooSoonError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('A collection finished a moment ago')
    this.name = 'RunTooSoonError'
  }
}

/**
 * A run this worker holds. `attempt` tells this hold apart from a later one
 * of the same run: if the run is taken up again by someone else, everything
 * the earlier holder still tries to write is ignored.
 */
export interface Claim {
  storeId: string
  runId: string
  attempt: number
}

export interface RunProgress {
  total: number
  ok: number
  failed: number
}

// How long after a run a person has to wait before asking for another one.
// Pages read in the last hours are reused anyway, so a new run right after a
// good one would only add rows. After a refusal by the website, insisting
// soon is exactly what must not happen. A run that failed for another
// reason (no key, KuantoKusta away) may be tried again almost at once.
const MANUAL_WAIT_MS: Record<string, number> = {
  succeeded: 15 * 60_000,
  partial: 15 * 60_000,
  blocked: 60 * 60_000,
  failed: 60_000
}
// A worker that is alive writes a heartbeat far more often than this.
const ABANDONED_AFTER_SECONDS = 180
// A run that was abandoned this many times is not tried again.
const MAX_ATTEMPTS = 3
// Names the lock that makes workers choose their next run one at a time.
const CLAIM_LOCK = 'kk_collection_claim'

const VIEW = {
  id: true,
  status: true,
  trigger: true,
  requested_by: true,
  items_total: true,
  items_ok: true,
  items_failed: true,
  error_code: true,
  queued_at: true,
  started_at: true,
  finished_at: true
} as const

type Row = {
  id: string
  status: string
  trigger: string
  requested_by: string | null
  items_total: number
  items_ok: number
  items_failed: number
  error_code: string | null
  queued_at: Date
  started_at: Date | null
  finished_at: Date | null
}

@Injectable()
export class CollectionRunsService {
  private readonly logger = new Logger(CollectionRunsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  /**
   * Asks for a full collection of the store.
   *
   * If one is already waiting or running, that one is returned instead:
   * asking twice never produces two. The database guarantees it with a
   * unique index, also when the two requests arrive at the same instant.
   */
  async request(
    storeId: string,
    origin:
      | { trigger: 'schedule' }
      | { trigger: 'manual', requestedBy: string, ignoreWait?: boolean },
    actor: AuditActor
  ): Promise<{ run: RunView, created: boolean }> {
    const active = await this.active(storeId)
    if (active) return { run: active, created: false }

    if (origin.trigger === 'manual' && !origin.ignoreWait) {
      const last = await this.latest(storeId)
      if (last?.finishedAt) {
        const wait = MANUAL_WAIT_MS[last.status] ?? 0
        const since = Date.now() - last.finishedAt.getTime()
        if (since < wait) {
          throw new RunTooSoonError(Math.ceil((wait - since) / 1000))
        }
      }
    }

    const id = uuidV7()
    const requestedBy = origin.trigger === 'manual'
      ? origin.requestedBy.trim().slice(0, 120) || 'unknown'
      : null
    try {
      const run = await this.prisma.withStore(storeId, async (tx) => {
        const row = await tx.job_runs.create({
          data: {
            id,
            store_id: storeId,
            job_type: FULL_COLLECTION,
            trigger: origin.trigger,
            requested_by: requestedBy
          },
          select: VIEW
        })
        await this.audit.record(tx, {
          actor,
          action: 'kk_run.requested',
          storeId,
          target: id,
          details: { trigger: origin.trigger, requestedBy }
        })
        return toView(row)
      })
      return { run, created: true }
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      // Someone else asked at the same instant and won.
      const winner = await this.active(storeId)
      if (!winner) throw error
      return { run: winner, created: false }
    }
  }

  async get(storeId: string, runId: string): Promise<RunView | null> {
    const row = await this.prisma.withStore(storeId, (tx) =>
      tx.job_runs.findFirst({
        where: { id: runId, job_type: FULL_COLLECTION },
        select: VIEW
      })
    )
    return row ? toView(row) : null
  }

  /** The store's most recent runs, newest first. */
  async list(storeId: string, limit: number): Promise<RunView[]> {
    const rows = await this.prisma.withStore(storeId, (tx) =>
      tx.job_runs.findMany({
        where: { job_type: FULL_COLLECTION },
        orderBy: { queued_at: 'desc' },
        take: Math.min(Math.max(limit, 1), 50),
        select: VIEW
      })
    )
    return rows.map(toView)
  }

  async latest(storeId: string): Promise<RunView | null> {
    return (await this.list(storeId, 1))[0] ?? null
  }

  /** How the offers of a run compared, by outcome. */
  async summary(storeId: string, runId: string): Promise<ComparisonCounts> {
    const groups = await this.prisma.withStore(storeId, (tx) =>
      tx.kk_price_comparisons.groupBy({
        by: ['outcome'],
        where: { run_id: runId },
        _count: { _all: true }
      })
    )
    const counts: ComparisonCounts = {
      cheapest: 0,
      tied: 0,
      more_expensive: 0,
      only_store: 0,
      no_data: 0
    }
    for (const group of groups) {
      if (group.outcome in counts) {
        counts[group.outcome as keyof ComparisonCounts] = group._count._all
      }
    }
    return counts
  }

  // ---- What follows is used by the worker only. ----

  /**
   * Takes the oldest waiting run of any store and marks it as running.
   * Returns null when nothing is waiting, or when a run of any store is
   * already being carried out: one at a time for the whole hub.
   */
  async claimNext(): Promise<Claim | null> {
    const storeIds = await this.storeIds()
    if (storeIds.length === 0) return null

    return this.prisma.$transaction(
      async (tx) => {
        // Two workers deciding at the same instant would both see "nothing
        // is running". They take turns instead.
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${CLAIM_LOCK}, 0))`

        // `job_runs` is protected per store, so "every active run" cannot
        // be asked in one query: each store is looked at in turn.
        let oldest: { storeId: string, runId: string, queuedAt: Date } | null
          = null
        for (const storeId of storeIds) {
          await tx.$queryRaw`
            SELECT set_config('app.current_store_id', ${storeId}, true)`
          const active = await tx.job_runs.findMany({
            where: {
              job_type: FULL_COLLECTION,
              status: { in: ['queued', 'running'] }
            },
            select: { id: true, status: true, queued_at: true }
          })
          for (const run of active) {
            if (run.status === 'running') return null
            if (!oldest || run.queued_at < oldest.queuedAt) {
              oldest = { storeId, runId: run.id, queuedAt: run.queued_at }
            }
          }
        }
        if (!oldest) return null

        await tx.$queryRaw`
          SELECT set_config('app.current_store_id', ${oldest.storeId}, true)`
        const claimed = await tx.$queryRaw<{ attempts: number }[]>`
          UPDATE job_runs
             SET status = 'running',
                 started_at = GREATEST(now(), queued_at),
                 heartbeat_at = GREATEST(now(), queued_at),
                 attempts = attempts + 1
           WHERE id = ${oldest.runId}::uuid
             AND status = 'queued'
          RETURNING attempts`
        if (claimed.length === 0) return null
        return {
          storeId: oldest.storeId,
          runId: oldest.runId,
          attempt: claimed[0].attempts
        }
      },
      { timeout: 15_000 }
    )
  }

  /**
   * Says "still working", and how far the run has got. Returns false when
   * the run is no longer this worker's: it was given up as abandoned and
   * maybe taken up by another. The caller must then stop.
   */
  async heartbeat(claim: Claim, progress?: RunProgress): Promise<boolean> {
    const updated = await this.prisma.withStore(claim.storeId, (tx) =>
      tx.$executeRaw`
        UPDATE job_runs
           SET heartbeat_at = GREATEST(clock_timestamp(), started_at),
               items_total = COALESCE(${progress?.total ?? null}::int, items_total),
               items_ok = COALESCE(${progress?.ok ?? null}::int, items_ok),
               items_failed = COALESCE(${progress?.failed ?? null}::int, items_failed)
         WHERE id = ${claim.runId}::uuid
           AND status = 'running'
           AND attempts = ${claim.attempt}`
    )
    return updated === 1
  }

  async finish(
    claim: Claim,
    result:
      | { status: 'succeeded' | 'partial', progress: RunProgress }
      | { status: 'failed' | 'blocked', errorCode: string, progress?: RunProgress }
  ): Promise<void> {
    const { progress } = result
    const updated = await this.prisma.withStore(claim.storeId, (tx) =>
      tx.$executeRaw`
        UPDATE job_runs
           SET status = ${result.status},
               error_code = ${'errorCode' in result ? result.errorCode : null},
               items_total = COALESCE(${progress?.total ?? null}::int, items_total),
               items_ok = COALESCE(${progress?.ok ?? null}::int, items_ok),
               items_failed = COALESCE(${progress?.failed ?? null}::int, items_failed),
               finished_at = GREATEST(clock_timestamp(), started_at)
         WHERE id = ${claim.runId}::uuid
           AND status = 'running'
           AND attempts = ${claim.attempt}`
    )
    this.logger.log(
      `Collection finished store=${claim.storeId} run=${claim.runId} `
      + `status=${result.status} `
      + `error=${'errorCode' in result ? result.errorCode : '-'} `
      + `total=${progress?.total ?? '-'} ok=${progress?.ok ?? '-'} `
      + `failed=${progress?.failed ?? '-'}`
      + (updated === 1 ? '' : ' (not recorded: the run was no longer held)')
    )
  }

  /**
   * Puts a running run back in the queue, to be taken up again later. The
   * pages it already read are kept and reused, so nothing is read twice.
   *
   * Used when the service is asked to stop. That is not the run's fault, so
   * it does not count as one of its attempts.
   */
  async requeue(claim: Claim): Promise<void> {
    await this.prisma.withStore(claim.storeId, (tx) =>
      tx.$executeRaw`
        UPDATE job_runs
           SET status = 'queued', started_at = NULL, heartbeat_at = NULL,
               items_total = 0, items_ok = 0, items_failed = 0,
               attempts = GREATEST(attempts - 1, 0)
         WHERE id = ${claim.runId}::uuid
           AND status = 'running'
           AND attempts = ${claim.attempt}`
    )
    this.logger.warn(
      `Collection put back in the queue store=${claim.storeId} `
      + `run=${claim.runId}`
    )
  }

  /**
   * Deals with runs whose worker went away without saying so (a crash, a
   * deploy that did not wait). They go back to the queue, or are failed if
   * that already happened too often.
   */
  async recoverAbandoned(): Promise<number> {
    let recovered = 0
    for (const storeId of await this.storeIds()) {
      recovered += await this.prisma.withStore(storeId, async (tx) => {
        const failed = await tx.$executeRaw`
          UPDATE job_runs
             SET status = 'failed', error_code = 'abandoned',
                 finished_at = GREATEST(clock_timestamp(), started_at)
           WHERE job_type = ${FULL_COLLECTION}
             AND status = 'running'
             AND attempts >= ${MAX_ATTEMPTS}
             AND COALESCE(heartbeat_at, started_at)
                 < now() - make_interval(secs => ${ABANDONED_AFTER_SECONDS})`
        const requeued = await tx.$executeRaw`
          UPDATE job_runs
             SET status = 'queued', started_at = NULL, heartbeat_at = NULL,
                 items_total = 0, items_ok = 0, items_failed = 0
           WHERE job_type = ${FULL_COLLECTION}
             AND status = 'running'
             AND COALESCE(heartbeat_at, started_at)
                 < now() - make_interval(secs => ${ABANDONED_AFTER_SECONDS})`
        if (failed + requeued > 0) {
          this.logger.warn(
            `Abandoned collections store=${storeId} `
            + `failed=${failed} requeued=${requeued}`
          )
        }
        return failed + requeued
      })
    }
    return recovered
  }

  /** The time a scheduled run of the store was last asked for, if ever. */
  async lastScheduledAt(storeId: string): Promise<Date | null> {
    const row = await this.prisma.withStore(storeId, (tx) =>
      tx.job_runs.findFirst({
        where: { job_type: FULL_COLLECTION, trigger: 'schedule' },
        orderBy: { queued_at: 'desc' },
        select: { queued_at: true }
      })
    )
    return row?.queued_at ?? null
  }

  private async active(storeId: string): Promise<RunView | null> {
    const row = await this.prisma.withStore(storeId, (tx) =>
      tx.job_runs.findFirst({
        where: {
          job_type: FULL_COLLECTION,
          status: { in: ['queued', 'running'] }
        },
        select: VIEW
      })
    )
    return row ? toView(row) : null
  }

  /**
   * The worker visits each store in turn (see claimNext). Fine for the
   * handful of stores the hub has; with many, this is the first thing to
   * revisit.
   */
  private async storeIds(): Promise<string[]> {
    const stores = await this.prisma.stores.findMany({
      select: { id: true },
      orderBy: { created_at: 'asc' },
      take: 500
    })
    return stores.map((store) => store.id)
  }
}

function toView(row: Row): RunView {
  return {
    id: row.id,
    status: row.status as RunStatus,
    trigger: row.trigger === 'schedule' ? 'schedule' : 'manual',
    requestedBy: row.requested_by,
    itemsTotal: row.items_total,
    itemsOk: row.items_ok,
    itemsFailed: row.items_failed,
    errorCode: row.error_code,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  }
}
