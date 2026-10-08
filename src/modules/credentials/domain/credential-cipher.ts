import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Encrypts one store credential with AES-256-GCM.
 *
 * GCM gives confidentiality and integrity: a ciphertext that was altered, or
 * that is opened with the wrong key, fails to decrypt instead of yielding
 * garbage.
 *
 * `context` is authenticated but not encrypted. It names the row the secret
 * belongs to (store, provider, key version), so a ciphertext copied into
 * another store's row does not decrypt there.
 */
const ALGORITHM = 'aes-256-gcm'
const NONCE_BYTES = 12
const TAG_BYTES = 16

export interface SealedCredential {
  /** The encrypted secret followed by the 16-byte authentication tag. */
  ciphertext: Buffer
  /** Random per encryption. Never reused with the same key. */
  nonce: Buffer
}

export class CredentialDecryptionError extends Error {
  constructor() {
    // No detail on purpose: wrong key, altered data and wrong context are
    // indistinguishable to a caller, as they should be.
    super('The stored credential could not be decrypted')
    this.name = 'CredentialDecryptionError'
  }
}

export function credentialContext(
  storeId: string,
  provider: string,
  keyVersion: number
): string {
  return `pharma-hub/credential/v1|${storeId}|${provider}|${keyVersion}`
}

export function sealCredential(
  secret: string,
  key: Buffer,
  context: string
): SealedCredential {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, nonce)
  cipher.setAAD(Buffer.from(context, 'utf8'))
  const encrypted = Buffer.concat([
    cipher.update(secret, 'utf8'),
    cipher.final()
  ])
  return {
    ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]),
    nonce
  }
}

export function openCredential(
  sealed: { ciphertext: Uint8Array, nonce: Uint8Array },
  key: Buffer,
  context: string
): string {
  const ciphertext = Buffer.from(sealed.ciphertext)
  if (sealed.nonce.length !== NONCE_BYTES || ciphertext.length < TAG_BYTES) {
    throw new CredentialDecryptionError()
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, sealed.nonce, {
      authTagLength: TAG_BYTES
    })
    decipher.setAAD(Buffer.from(context, 'utf8'))
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_BYTES))
    return Buffer.concat([
      decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_BYTES)),
      decipher.final()
    ]).toString('utf8')
  } catch {
    throw new CredentialDecryptionError()
  }
}
