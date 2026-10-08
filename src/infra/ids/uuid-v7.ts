import { randomBytes } from 'node:crypto'

/**
 * A UUID version 7: 48 bits of Unix time in milliseconds, then random bits.
 *
 * Ids that leave the service (stores, tokens, runs) use it because rows
 * created together sort together, which keeps the primary key index compact,
 * while the id still reveals nothing a caller could guess the next one from.
 */
export function uuidV7(now: number = Date.now()): string {
  const bytes = randomBytes(16)
  bytes.writeUIntBE(now, 0, 6)
  bytes[6] = (bytes[6] & 0x0f) | 0x70 // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // RFC 9562 variant

  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join('-')
}
