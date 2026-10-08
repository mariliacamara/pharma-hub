import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common'
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common'
import type { Response } from 'express'

import { ApiError } from './api-error'
import type { ApiErrorBody } from './api-error'
import type { HubRequest } from './hub-request'

// Failures raised by the framework itself. Its own messages can quote part
// of what the caller sent, so a fixed text is used instead.
const FRAMEWORK_ERRORS: Readonly<Record<number, [string, string]>> = {
  400: ['bad_request', 'The request could not be read'],
  404: ['not_found', 'There is nothing at this address'],
  405: ['method_not_allowed', 'This address does not accept that method'],
  413: ['payload_too_large', 'The request body is too large'],
  415: ['unsupported_media_type', 'The request body must be JSON']
}

/**
 * Turns every failure into the same response shape.
 *
 * An error the service raised on purpose (ApiError) keeps its code and
 * message. Anything unexpected is logged in full and answered with a bare
 * "internal_error": the cause is for the log, not for the caller.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name)

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp()
    const request = http.getRequest<HubRequest>()
    const response = http.getResponse<Response>()
    const requestId = request.requestId ?? null

    const { status, code, message } = this.describe(exception, requestId)

    if (status === HttpStatus.UNAUTHORIZED) {
      response.setHeader('WWW-Authenticate', 'Bearer')
    }

    const body: ApiErrorBody = { error: { code, message }, requestId }
    response.status(status).json(body)
  }

  private describe(
    exception: unknown,
    requestId: string | null
  ): { status: number, code: string, message: string } {
    if (exception instanceof ApiError) {
      return {
        status: exception.getStatus(),
        code: exception.code,
        message: exception.message
      }
    }

    // Raised by the framework or by the body parser beneath it: unknown
    // route, malformed JSON, body too large.
    const status = frameworkStatus(exception)
    if (status !== null && status >= 400 && status < 500) {
      const [code, message] = FRAMEWORK_ERRORS[status] ?? [
        'request_rejected',
        'The request was not accepted'
      ]
      return { status, code, message }
    }

    this.logger.error(
      `Unhandled error request=${requestId ?? '-'}`,
      exception instanceof Error ? exception.stack : String(exception)
    )
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'internal_error',
      message: 'Something went wrong on our side'
    }
  }
}

/** The HTTP status an error asks for, when it is a client error. */
function frameworkStatus(exception: unknown): number | null {
  if (exception instanceof HttpException) return exception.getStatus()
  // The body parser signals "too large" and the like with a plain error
  // that carries a status, not with the framework's exception class.
  if (
    typeof exception === 'object'
    && exception !== null
    && 'status' in exception
    && typeof exception.status === 'number'
    && Number.isInteger(exception.status)
  ) {
    return exception.status
  }
  return null
}
