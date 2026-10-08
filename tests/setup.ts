import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

// Runs before every test file.
//
// The environment is validated when `#/infra/config/env` is first imported.
// Unit tests never open a connection, so a placeholder is enough for them;
// integration tests use the real value from `.env` or the environment.
//
// Jest gives each test file its own copy of `process.env`, and
// `process.loadEnvFile()` writes to the real one, which the tests do not
// see. So the file is read here and applied to the copy. As everywhere else,
// a variable already set in the environment wins over the file.
let fromFile: Record<string, string | undefined> = {}
try {
  fromFile = parseEnv(readFileSync('.env', 'utf8'))
} catch {
  // No .env file: the variables come from the environment.
}

for (const [name, value] of Object.entries(fromFile)) {
  process.env[name] ??= value
}

process.env.NODE_ENV = 'test'
process.env.DATABASE_URL ??= 'postgresql://unit:unit@localhost:5432/unit'
// A key for tests only. Thirty-two bytes that are obviously not random.
process.env.CREDENTIALS_MASTER_KEY ??= `1:${Buffer.from(
  'pharma-hub-test-master-key-00001'
).toString('base64')}`
