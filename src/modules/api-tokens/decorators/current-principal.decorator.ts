import { createParamDecorator } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'

import type { HubRequest } from '#/infra/http/hub-request'

import type { TokenPrincipal } from '../domain/token-principal'

/**
 * The verified caller of a plugin route. Only usable behind ApiTokenGuard:
 * without it there is no principal, and this fails instead of guessing.
 */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TokenPrincipal => {
    const { principal } = context.switchToHttp().getRequest<HubRequest>()
    if (!principal) {
      throw new Error('CurrentPrincipal used on a route without ApiTokenGuard')
    }
    return principal
  }
)
