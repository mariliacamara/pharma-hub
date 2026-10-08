import { randomBytes } from 'node:crypto'

import { describe, it, expect } from '@jest/globals'

import {
  CredentialDecryptionError,
  credentialContext,
  openCredential,
  sealCredential
} from '#/modules/credentials/domain/credential-cipher'

const SECRET = 'kk-live-4f9a2c7d1e8b4a6f-ZINCOMED'
const key = randomBytes(32)
const context = credentialContext(
  '019fc5d3-5c00-7000-8000-000000000001',
  'kuantokusta',
  1
)

describe('credential cipher', () => {
  it('returns the secret it was given', () => {
    expect(openCredential(sealCredential(SECRET, key, context), key, context))
      .toBe(SECRET)
  })

  it('handles any text, including accents and an empty string', () => {
    for (const secret of ['', 'ç', 'chave com espaço e ação', 'x'.repeat(512)]) {
      const sealed = sealCredential(secret, key, context)

      expect(openCredential(sealed, key, context)).toBe(secret)
    }
  })

  it('stores nothing readable', () => {
    const { ciphertext, nonce } = sealCredential(SECRET, key, context)

    expect(nonce).toHaveLength(12)
    expect(ciphertext).toHaveLength(Buffer.byteLength(SECRET) + 16)
    expect(ciphertext.toString('latin1')).not.toContain(SECRET.slice(0, 8))
    expect(ciphertext.toString('latin1')).not.toContain(SECRET.slice(-8))
  })

  it('uses a new nonce every time, so equal secrets look different', () => {
    const sealed = Array.from({ length: 200 }, () =>
      sealCredential(SECRET, key, context)
    )

    expect(new Set(sealed.map((s) => s.nonce.toString('hex'))).size).toBe(200)
    expect(new Set(sealed.map((s) => s.ciphertext.toString('hex'))).size)
      .toBe(200)
  })

  it('refuses another key', () => {
    const sealed = sealCredential(SECRET, key, context)

    expect(() => openCredential(sealed, randomBytes(32), context))
      .toThrow(CredentialDecryptionError)
  })

  it('refuses a ciphertext moved to another store, provider or key version', () => {
    const sealed = sealCredential(SECRET, key, context)
    const elsewhere = [
      credentialContext('019fc5d3-5c00-7000-8000-000000000002', 'kuantokusta', 1),
      credentialContext('019fc5d3-5c00-7000-8000-000000000001', 'other', 1),
      credentialContext('019fc5d3-5c00-7000-8000-000000000001', 'kuantokusta', 2)
    ]

    for (const other of elsewhere) {
      expect(() => openCredential(sealed, key, other))
        .toThrow(CredentialDecryptionError)
    }
  })

  it('refuses data changed by a single bit, anywhere', () => {
    const sealed = sealCredential(SECRET, key, context)

    for (let i = 0; i < sealed.ciphertext.length; i++) {
      const ciphertext = Buffer.from(sealed.ciphertext)
      ciphertext[i] ^= 0x01

      expect(() => openCredential({ ...sealed, ciphertext }, key, context))
        .toThrow(CredentialDecryptionError)
    }
    const nonce = Buffer.from(sealed.nonce)
    nonce[0] ^= 0x01

    expect(() => openCredential({ ...sealed, nonce }, key, context))
      .toThrow(CredentialDecryptionError)
  })

  it.each([
    ['a truncated ciphertext', Buffer.alloc(15), Buffer.alloc(12)],
    ['a short nonce', Buffer.alloc(40), Buffer.alloc(8)],
    ['empty data', Buffer.alloc(0), Buffer.alloc(0)]
  ])('refuses %s without crashing', (_case, ciphertext, nonce) => {
    expect(() => openCredential({ ciphertext, nonce }, key, context))
      .toThrow(CredentialDecryptionError)
  })

  it('says nothing about why it failed', () => {
    const sealed = sealCredential(SECRET, key, context)
    let message = ''
    try {
      openCredential(sealed, randomBytes(32), context)
    } catch (error) {
      message = String(error)
    }

    expect(message).toBe(
      'CredentialDecryptionError: The stored credential could not be decrypted'
    )
  })
})
