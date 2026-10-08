import { defineConfig } from 'prisma/config'

// The Prisma CLI does not read .env by itself. Load it when present (local
// development); in production the variables come from the environment.
try {
  process.loadEnvFile()
} catch {
  // No .env file: nothing to load.
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations'
  },
  datasource: {
    // The privileged connection: migrations and introspection only. The application
    // itself connects with DATABASE_URL, as a role that cannot bypass Row Level Security.
    // Left undefined for `prisma generate`, which needs no database.
    url: process.env.DATABASE_MIGRATION_URL
  }
})
