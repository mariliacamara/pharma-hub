import { describe, it, expect } from '@jest/globals'

import {
  generateToken,
  hashToken,
  prefixOf,
  readBearerToken
} from '#/modules/api-tokens/domain/token'

describe('plugin token', () => {
  it('is "phk_" followed by 256 random bits', () => {
    const { token } = generateToken()

    expect(token).toMatch(/^phk_[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(token.slice(4), 'base64url')).toHaveLength(32)
  })

  it('never repeats', () => {
    const tokens = new Set(
      Array.from({ length: 1000 }, () => generateToken().token)
    )

    expect(tokens.size).toBe(1000)
  })

  it('is stored as a 32-byte hash that does not contain the token', () => {
    const { token, hash, prefix } = generateToken()

    expect(hash).toHaveLength(32)
    expect(hash.equals(hashToken(token))).toBe(true)
    expect(hash.toString('latin1')).not.toContain(token.slice(4, 20))
    expect(prefix).toBe(token.slice(4, 12))
    expect(prefixOf(token)).toBe(prefix)
  })

  it('hashes different tokens differently', () => {
    expect(
      hashToken(generateToken().token).equals(hashToken(generateToken().token))
    ).toBe(false)
  })
})

describe('readBearerToken', () => {
  const { token } = generateToken()

  it('reads a well-formed header', () => {
    expect(readBearerToken(`Bearer ${token}`)).toBe(token)
    expect(readBearerToken(`bearer ${token}`)).toBe(token)
  })

  it.each([
    ['nothing', undefined],
    ['an empty header', ''],
    ['the token without the scheme', token],
    ['another scheme', `Basic ${token}`],
    ['a token without the marker', `Bearer ${token.slice(4)}`],
    ['a token that is too short', `Bearer ${token.slice(0, -1)}`],
    ['a token that is too long', `Bearer ${token}A`],
    ['a token with a forbidden character', `Bearer ${token.slice(0, -1)}+`],
    ['two tokens', `Bearer ${token} ${token}`],
    ['a trailing line break', `Bearer ${token}\n`],
    ['a list of headers', [`Bearer ${token}`]]
  ])('refuses %s', (_case, header) => {
    expect(readBearerToken(header)).toBeNull()
  })
})
