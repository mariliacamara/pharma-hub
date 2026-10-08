import type { Request } from 'express'

import type { TokenPrincipal } from '#/modules/api-tokens/domain/token-principal'

/** The Express request, plus what this service attaches to it. */
export interface HubRequest extends Request {
  /** Set by the request context middleware on every request. */
  requestId?: string
  /** Set by ApiTokenGuard once the token has been verified. */
  principal?: TokenPrincipal
}
