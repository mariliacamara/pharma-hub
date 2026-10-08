/** What a plugin token may do. The database holds the same list in a CHECK. */
export const TOKEN_SCOPES = [
  'credentials:write',
  'prices:read',
  'prices:refresh'
] as const

export type TokenScope = (typeof TOKEN_SCOPES)[number]

export function isTokenScope(value: string): value is TokenScope {
  return (TOKEN_SCOPES as readonly string[]).includes(value)
}

/**
 * The caller of a plugin route, as established by its token.
 *
 * The store comes from here and from nowhere else: no route reads a store
 * id from the URL, the query string or the body.
 */
export interface TokenPrincipal {
  readonly tokenId: string
  readonly tokenPrefix: string
  readonly storeId: string
  readonly scopes: readonly TokenScope[]
}
