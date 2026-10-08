import { SetMetadata } from '@nestjs/common'

import type { TokenScope } from '../domain/token-principal'

export const REQUIRED_SCOPES = 'api-tokens:required-scopes'

/**
 * Declares what a token needs in order to call a route.
 *
 * A route behind ApiTokenGuard that declares nothing is refused: forgetting
 * this decorator closes the route instead of opening it.
 */
export const RequireScopes = (...scopes: [TokenScope, ...TokenScope[]]) =>
  SetMetadata(REQUIRED_SCOPES, scopes)
