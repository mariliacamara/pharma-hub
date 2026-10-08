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

function isPostgresUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'postgresql:' || protocol === 'postgres:'
  } catch {
    return false
  }
}

const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  PORT: z.coerce.number().int().min(1).max(65535).default(7000),

  // Connection of the application role (pharma_hub_app). Never the owner's:
  // see docs/decisions/0016.
  DATABASE_URL: z
    .string({ error: 'is required' })
    .refine(isPostgresUrl, {
      error: 'must be a postgresql:// connection string'
    })
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
