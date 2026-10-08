import { describe, beforeAll, it, expect } from '@jest/globals'
import { Logger } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'

import { ApiError } from '#/infra/http/api-error'
import type { HubRequest } from '#/infra/http/hub-request'
import { Public } from '#/modules/api-tokens/decorators/public.decorator'
import { RequireScopes } from '#/modules/api-tokens/decorators/require-scopes.decorator'
import { generateToken } from '#/modules/api-tokens/domain/token'
import type { TokenPrincipal } from '#/modules/api-tokens/domain/token-principal'
import { ApiTokenGuard } from '#/modules/api-tokens/guards/api-token.guard'
import type { ApiTokensService } from '#/modules/api-tokens/services/api-tokens.service'

const known = generateToken().token
const principal: TokenPrincipal = {
  tokenId: '019fc5d3-5c00-7000-8000-0000000000aa',
  tokenPrefix: known.slice(4, 12),
  storeId: '019fc5d3-5c00-7000-8000-000000000001',
  scopes: ['prices:read']
}

class Routes {
  @RequireScopes('prices:read')
  read() {}

  @RequireScopes('prices:read', 'prices:refresh')
  refresh() {}

  undeclared() {}

  @Public()
  open() {}
}

@Public()
class OpenRoutes {
  anything() {}
}

function setup() {
  const lookups: string[] = []
  const tokens = {
    authenticate: async (token: string) => {
      lookups.push(token)
      return token === known ? principal : null
    }
  } as unknown as ApiTokensService
  const guard = new ApiTokenGuard(tokens, new Reflector())

  const check = async (
    handler: keyof Routes | 'anything',
    authorization?: unknown
  ) => {
    const request = { headers: { authorization } } as unknown as HubRequest
    const owner = handler === 'anything' ? OpenRoutes : Routes
    const context = {
      getHandler: () =>
        (owner.prototype as unknown as Record<string, () => void>)[handler],
      getClass: () => owner,
      switchToHttp: () => ({ getRequest: () => request })
    } as unknown as ExecutionContext
    const outcome = await guard
      .canActivate(context)
      .catch((error: unknown) => error)
    return { outcome, request }
  }
  return { check, lookups }
}

const failure = (outcome: unknown) =>
  outcome instanceof ApiError
    ? `${outcome.getStatus()} ${outcome.code}`
    : outcome

describe('ApiTokenGuard', () => {
  beforeAll(() => {
    Logger.overrideLogger(false)
  })

  it('lets a known token with the scope through, and names its store', async () => {
    const { check } = setup()

    const { outcome, request } = await check('read', `Bearer ${known}`)

    expect(outcome).toBe(true)
    expect(request.principal).toEqual(principal)
  })

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['an unknown token', `Bearer ${generateToken().token}`],
    ['a malformed token', 'Bearer phk_short'],
    ['the token without "Bearer"', known],
    ['another scheme', `Basic ${known}`]
  ])('answers 401 to %s', async (_case, header) => {
    const { check } = setup()

    const { outcome, request } = await check('read', header)

    expect(failure(outcome)).toBe('401 invalid_token')
    expect(request.principal).toBeUndefined()
  })

  it('does not look up a malformed token in the database', async () => {
    const { check, lookups } = setup()

    await check('read', 'Bearer phk_short')
    await check('read', 'Bearer not-a-token')
    await check('read', undefined)

    expect(lookups).toEqual([])
  })

  it('answers 403 when the token lacks one of the required scopes', async () => {
    const { check } = setup()

    const { outcome } = await check('refresh', `Bearer ${known}`)

    expect(failure(outcome)).toBe('403 insufficient_scope')
  })

  it('refuses a route that declares no scope, even with a valid token', async () => {
    const { check } = setup()

    const { outcome } = await check('undeclared', `Bearer ${known}`)

    expect(failure(outcome)).toBe('403 forbidden')
  })

  it('lets anyone into a route or a controller marked as public', async () => {
    const { check, lookups } = setup()

    expect((await check('open')).outcome).toBe(true)
    expect((await check('anything')).outcome).toBe(true)
    // No token is looked at, even if one is sent.
    expect((await check('open', `Bearer ${known}`)).request.principal)
      .toBeUndefined()
    expect(lookups).toEqual([])
  })

  it('checks the token before saying anything about the route', async () => {
    const { check } = setup()

    const { outcome } = await check('undeclared', undefined)

    expect(failure(outcome)).toBe('401 invalid_token')
  })
})
