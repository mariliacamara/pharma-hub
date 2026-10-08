import { createHash, randomBytes } from 'node:crypto'

/**
 * Plugin tokens.
 *
 * A token is `phk_` followed by 256 random bits in base64url. The fixed
 * start lets a secret scanner recognise a leaked token; the rest is the
 * secret.
 *
 * Only the SHA-256 of the token is stored. A slow password hash is not
 * needed: with 256 random bits there is nothing to guess, and a fast hash
 * keeps the lookup on every request cheap. A leaked database yields no
 * usable token.
 */
const MARKER = 'phk_'
const SECRET_LENGTH = 43 // 32 bytes in base64url, without padding
const FORMAT = new RegExp(`^${MARKER}[A-Za-z0-9_-]{${SECRET_LENGTH}}$`)
const PREFIX_LENGTH = 8

export interface NewToken {
  /** The secret. Shown once to the person who asked for it, never stored. */
  token: string
  /** What is stored and looked up. */
  hash: Buffer
  /** The first characters of the secret part, to recognise it in a list. */
  prefix: string
}

export function generateToken(): NewToken {
  const token = MARKER + randomBytes(32).toString('base64url')
  return { token, hash: hashToken(token), prefix: prefixOf(token) }
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

export function prefixOf(token: string): string {
  return token.slice(MARKER.length, MARKER.length + PREFIX_LENGTH)
}

/**
 * Reads the token from an `Authorization` header.
 *
 * Returns null for anything that is not `Bearer <well-formed token>`, so a
 * malformed value is rejected before it costs a database lookup.
 */
export function readBearerToken(header: unknown): string | null {
  if (typeof header !== 'string') return null
  const match = /^Bearer ([^\s]+)$/i.exec(header)
  if (!match || !FORMAT.test(match[1])) return null
  return match[1]
}
