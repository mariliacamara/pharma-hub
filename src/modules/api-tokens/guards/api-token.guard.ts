import { Injectable, Logger } from '@nestjs/common'
import type { CanActivate, ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'

import { ApiError } from '#/infra/http/api-error'
import type { HubRequest } from '#/infra/http/hub-request'

import { IS_PUBLIC } from '../decorators/public.decorator'
import { REQUIRED_SCOPES } from '../decorators/require-scopes.decorator'
import { readBearerToken } from '../domain/token'
import type { TokenScope } from '../domain/token-principal'
import { ApiTokensService } from '../services/api-tokens.service'

/**
 * Guards every route of the application (it is registered globally in
 * AppModule). A route is open only if it is marked `@Public()`.
 *
 * 1. Authentication: the token in the `Authorization` header must be known,
 *    not revoked and not expired.
 * 2. Authorization: the token must hold every scope the route declares.
 *
 * On success the principal is attached to the request. The store it names is
 * the only store the request can touch.
 */
@Injectable()
export class ApiTokenGuard implements CanActivate {
  private readonly logger = new Logger(ApiTokenGuard.name)

  constructor(
    private readonly tokens: ApiTokensService,
    private readonly reflector: Reflector
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()]
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) {
      return true
    }

    const request = context.switchToHttp().getRequest<HubRequest>()

    const token = readBearerToken(request.headers.authorization)
    const principal = token ? await this.tokens.authenticate(token) : null
    if (!principal) {
      throw new ApiError(401, 'invalid_token', 'A valid token is required')
    }
    // Attached before the scope check, so a refused request is still logged
    // with the store and token it came from.
    request.principal = principal

    const required = this.reflector.getAllAndOverride<
      TokenScope[] | undefined
    >(REQUIRED_SCOPES, targets)
    if (!required || required.length === 0) {
      // A programming mistake, not a caller's fault. Fail closed and say so.
      this.logger.error(
        `${context.getClass().name}.${context.getHandler().name} `
        + 'declares no scope; refusing the request'
      )
      throw new ApiError(403, 'forbidden', 'This action is not available')
    }

    if (!required.every((scope) => principal.scopes.includes(scope))) {
      throw new ApiError(
        403,
        'insufficient_scope',
        `This token lacks a required scope: ${required.join(', ')}`
      )
    }

    return true
  }
}
