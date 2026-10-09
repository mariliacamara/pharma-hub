import type { RunView } from '../services/collection-runs.service'

/** A collection as the plugin sees it. Shared by the runs and report routes. */
export interface RunResponse {
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

export const NULLABLE_STRING = { type: ['string', 'null'] }

export const RUN_SCHEMA = {
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

export function presentRun(run: RunView): RunResponse {
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
