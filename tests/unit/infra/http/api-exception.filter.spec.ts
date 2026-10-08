import { describe, beforeAll, it, expect } from '@jest/globals'
import {
  BadRequestException,
  Logger,
  NotFoundException
} from '@nestjs/common'
import type { ArgumentsHost } from '@nestjs/common'

import { ApiError } from '#/infra/http/api-error'
import { ApiExceptionFilter } from '#/infra/http/api-exception.filter'

function answerTo(exception: unknown, requestId: string | null = 'req-1') {
  const sent: { status?: number, body?: unknown, headers: string[] } = {
    headers: []
  }
  const response = {
    setHeader: (name: string, value: string) => {
      sent.headers.push(`${name}: ${value}`)
    },
    status: (status: number) => {
      sent.status = status
      return response
    },
    json: (body: unknown) => {
      sent.body = body
    }
  }
  const host = {
    switchToHttp: () => ({
      getRequest: () => (requestId === null ? {} : { requestId }),
      getResponse: () => response
    })
  } as unknown as ArgumentsHost

  new ApiExceptionFilter().catch(exception, host)
  return sent
}

describe('ApiExceptionFilter', () => {
  beforeAll(() => {
    Logger.overrideLogger(false)
  })

  it('keeps the code and message of an error raised on purpose', () => {
    expect(
      answerTo(new ApiError(422, 'kk_key_rejected', 'The key was refused'))
    ).toEqual({
      status: 422,
      headers: [],
      body: {
        error: { code: 'kk_key_rejected', message: 'The key was refused' },
        requestId: 'req-1'
      }
    })
  })

  it('tells the client how to authenticate on a 401', () => {
    const sent = answerTo(new ApiError(401, 'invalid_token', 'No'))

    expect(sent.headers).toEqual(['WWW-Authenticate: Bearer'])
  })

  it('hides everything about an unexpected error', () => {
    const secret = 'postgresql://app:hunter2@10.0.0.5:5432/db'
    const sent = answerTo(new Error(`connect failed for ${secret}`))

    expect(sent.status).toBe(500)
    expect(sent.body).toEqual({
      error: {
        code: 'internal_error',
        message: 'Something went wrong on our side'
      },
      requestId: 'req-1'
    })
    expect(JSON.stringify(sent.body)).not.toContain('hunter2')
  })

  it('does not repeat a framework message, which may quote the request', () => {
    const sent = answerTo(
      new BadRequestException('Unexpected token k in JSON: "kk-secret-key"')
    )

    expect(sent.status).toBe(400)
    expect(sent.body).toEqual({
      error: { code: 'bad_request', message: 'The request could not be read' },
      requestId: 'req-1'
    })
  })

  it('answers an unknown route with not_found', () => {
    const sent = answerTo(new NotFoundException('Cannot GET /wp-admin'))

    expect(sent.body).toMatchObject({
      error: { code: 'not_found', message: 'There is nothing at this address' }
    })
  })

  it.each([undefined, null, 'text', 42, { not: 'an error' }])(
    'survives a thrown %j',
    (thrown) => {
      expect(answerTo(thrown).status).toBe(500)
    }
  )

  it('works before the request has an id', () => {
    expect(answerTo(new ApiError(400, 'x', 'y'), null).body).toEqual({
      error: { code: 'x', message: 'y' },
      requestId: null
    })
  })
})
