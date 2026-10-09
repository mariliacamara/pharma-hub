import { HttpException } from '@nestjs/common'

/**
 * An error the caller is meant to understand and act on.
 *
 * `code` is part of the API contract: clients branch on it, so it never
 * changes once published. `message` is for a person reading a log and may be
 * reworded. Neither ever contains a secret or an internal detail.
 */
export class ApiError extends HttpException {
  /** Sent as the `Retry-After` header: when trying again makes sense. */
  readonly retryAfterSeconds: number | null

  constructor(
    status: number,
    readonly code: string,
    message: string,
    options: { retryAfterSeconds?: number } = {}
  ) {
    super(message, status)
    this.name = 'ApiError'
    this.retryAfterSeconds = options.retryAfterSeconds ?? null
  }
}

/** The body of every error response. */
export interface ApiErrorBody {
  error: {
    code: string
    message: string
  }
  /** Quote it when asking for support: it finds the request in the log. */
  requestId: string | null
}
