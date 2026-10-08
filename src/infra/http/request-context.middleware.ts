import { randomUUID } from 'node:crypto'

import { Injectable, Logger } from '@nestjs/common'
import type { NestMiddleware } from '@nestjs/common'
import type { NextFunction, Response } from 'express'

import type { HubRequest } from './hub-request'

// A caller may send its own id to follow a request across systems. It ends
// up in the log, so only a harmless shape is accepted.
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/

/**
 * Gives every request an id and writes one log line when it finishes.
 *
 * The line carries the route pattern, never the query string or the body,
 * and identifies the caller by store and token prefix, never by the token.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger('Http')

  use(request: HubRequest, response: Response, next: NextFunction): void {
    const received = request.headers['x-request-id']
    const requestId
      = typeof received === 'string' && SAFE_REQUEST_ID.test(received)
        ? received
        : randomUUID()
    request.requestId = requestId
    response.setHeader('x-request-id', requestId)
    // Every answer is JSON for a machine. These cost nothing and close off
    // a browser guessing otherwise, and a banner naming the framework.
    response.setHeader('x-content-type-options', 'nosniff')
    response.removeHeader('x-powered-by')

    const startedAt = process.hrtime.bigint()
    response.on('finish', () => {
      const route: unknown = request.route?.path
      // An unmatched path is whatever a stranger typed: it is not logged.
      const path = typeof route === 'string'
        ? `${request.baseUrl}${route}`
        : '(unmatched)'
      // Health checks are frequent and say nothing; errors still show up.
      if (path.startsWith('/health/') && response.statusCode < 400) return

      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      this.logger.log(
        [
          `${request.method} ${path}`,
          `status=${response.statusCode}`,
          `ms=${durationMs.toFixed(1)}`,
          `request=${requestId}`,
          `store=${request.principal?.storeId ?? '-'}`,
          `token=${request.principal?.tokenPrefix ?? '-'}`
        ].join(' ')
      )
    })

    next()
  }
}
