import { z } from 'zod/v4'

/**
 * Environment configuration, validated once when this module is first
 * imported.
 *
 * The process refuses to start with a missing or malformed variable: a clear
 * error at boot is cheaper than a confusing one at the first request.
 */

// Local development reads .env; in production the variables come from the
// environment and there is no file to load.
try {
  process.loadEnvFile()
} catch {
  // No .env file: nothing to load.
}

/** One master key for encrypting store credentials, with its version. */
export interface CredentialKey {
  readonly version: number
  readonly key: Buffer
}

const KEY_FORMAT = 'must be "<version>:<base64 of 32 random bytes>"'

// The key printed in .env.example. Public, so worthless as a key.
const EXAMPLE_KEY = 'local-development-only-not-a-key'

function isPostgresUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'postgresql:' || protocol === 'postgres:'
  } catch {
    return false
  }
}

/** Reads "<version>:<base64 of 32 bytes>". Returns null when malformed. */
function readCredentialKey(entry: string): CredentialKey | null {
  const match = /^([1-9]\d{0,3}):([A-Za-z0-9+/]{43}=)$/.exec(entry.trim())
  if (!match) return null

  const key = Buffer.from(match[2], 'base64')
  // A key made of one repeated byte is a placeholder, not a key.
  if (key.length !== 32 || key.every((byte) => byte === key[0])) return null

  return { version: Number(match[1]), key }
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1'
}

const schema = z
  .object({
    // Production unless stated otherwise. The conveniences of development
    // (the public API reference, a fake KuantoKusta over plain HTTP) must be
    // asked for, never fallen into because a variable was left out.
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('production'),

    PORT: z.coerce.number().int().min(1).max(65535).default(7000),

    // Connection of the application role (pharma_hub_app). Never the owner's:
    // see docs/decisions/0016.
    DATABASE_URL: z
      .string({ error: 'is required' })
      .refine(isPostgresUrl, {
        error: 'must be a postgresql:// connection string'
      }),

    // The key that encrypts every store's credentials before they are stored
    // (docs/decisions/0003). Losing it makes the stored credentials
    // unreadable; leaking it, together with the database, exposes them.
    CREDENTIALS_MASTER_KEY: z
      .string({ error: 'is required' })
      .transform((value, context) => {
        const key = readCredentialKey(value)
        if (key) return key
        // The value is a secret: the message names the rule, never the value.
        context.issues.push({ code: 'custom', message: KEY_FORMAT, input: '' })
        return z.NEVER
      }),

    // Older keys, comma-separated, kept only to read credentials that were
    // encrypted before a rotation.
    CREDENTIALS_PREVIOUS_KEYS: z
      .string()
      .default('')
      .transform((value, context) => {
        const entries = value.split(',').filter((entry) => entry.trim() !== '')
        const keys = entries
          .map(readCredentialKey)
          .filter((key) => key !== null)
        if (keys.length === entries.length) return keys

        context.issues.push({
          code: 'custom',
          message: `each entry ${KEY_FORMAT}`,
          input: ''
        })
        return z.NEVER
      }),

    // Where the KuantoKusta Seller API lives. Production by default; the
    // sandbox is https://seller-sandbox.kuantokusta.pt/api.
    KK_SELLER_API_BASE_URL: z
      .string()
      .default('https://seller.kuantokusta.pt/api')
      .refine((value) => URL.canParse(value), { error: 'must be a URL' })
  })
  .superRefine((value, context) => {
    const versions = value.CREDENTIALS_PREVIOUS_KEYS.map((key) => key.version)
    const repeated
      = new Set(versions).size !== versions.length
        || versions.includes(value.CREDENTIALS_MASTER_KEY.version)
    if (repeated) {
      context.addIssue({
        code: 'custom',
        path: ['CREDENTIALS_PREVIOUS_KEYS'],
        message: 'every key needs its own version number'
      })
    }

    const keys = [value.CREDENTIALS_MASTER_KEY, ...value.CREDENTIALS_PREVIOUS_KEYS]
    const usesExample = keys.some(
      (entry) => entry.key.toString('latin1') === EXAMPLE_KEY
    )
    if (value.NODE_ENV === 'production' && usesExample) {
      context.addIssue({
        code: 'custom',
        path: ['CREDENTIALS_MASTER_KEY'],
        message:
          'is the example key from .env.example; '
          + 'generate one with: openssl rand -base64 32'
      })
    }

    // Already reported above as "must be a URL".
    if (!URL.canParse(value.KK_SELLER_API_BASE_URL)) return

    // The store's API key travels to this address, so it must be encrypted
    // in transit. Plain HTTP is accepted only for a local fake in tests.
    const api = new URL(value.KK_SELLER_API_BASE_URL)
    const localFake
      = value.NODE_ENV !== 'production'
        && api.protocol === 'http:'
        && isLoopback(api.hostname)
    if (api.protocol !== 'https:' && !localFake) {
      context.addIssue({
        code: 'custom',
        path: ['KK_SELLER_API_BASE_URL'],
        message: 'must use https'
      })
    }
    // In production the key only ever goes to KuantoKusta. A typo in this
    // variable must not send every store's key to someone else's server.
    const kuantokusta
      = api.hostname === 'kuantokusta.pt'
        || api.hostname.endsWith('.kuantokusta.pt')
    if (value.NODE_ENV === 'production' && !kuantokusta) {
      context.addIssue({
        code: 'custom',
        path: ['KK_SELLER_API_BASE_URL'],
        message: 'must be an address of kuantokusta.pt'
      })
    }
    if (api.username !== '' || api.password !== '' || api.search !== '') {
      context.addIssue({
        code: 'custom',
        path: ['KK_SELLER_API_BASE_URL'],
        message: 'must not carry credentials or a query string'
      })
    }
  })

export type Env = z.infer<typeof schema>

export class EnvError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid environment configuration:\n- ${problems.join('\n- ')}`)
    this.name = 'EnvError'
  }
}

export function parseEnv(
  source: Readonly<Record<string, string | undefined>>
): Env {
  const result = schema.safeParse(source)
  if (result.success) return result.data

  // Only the variable name and the rule are reported. Values are secrets
  // (DATABASE_URL carries a password), so they are never echoed back.
  throw new EnvError(
    result.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`
    )
  )
}

export const env = parseEnv(process.env)
