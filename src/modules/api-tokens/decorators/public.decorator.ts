import { SetMetadata } from '@nestjs/common'

export const IS_PUBLIC = 'api-tokens:is-public'

/**
 * Marks a route that anyone may call without a token.
 *
 * Every route is closed unless it says otherwise: ApiTokenGuard is applied to
 * the whole application, so a new controller that declares nothing is
 * refused, not exposed. Use this for the very few routes that must be open,
 * such as the health checks.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true)
