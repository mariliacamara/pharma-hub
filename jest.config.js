import { defineConfig } from 'jest'

// Unit tests: no database, no network.
export default defineConfig({
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  extensionsToTreatAsEsm: ['.ts'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/integration/'],
  // Coverage is measured on the code unit tests can reach. Left out: the
  // generated Prisma client, the wiring (main, modules) and the database
  // client, which is proven by the integration tests instead.
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/generated/**',
    '!src/main.ts',
    '!src/**/*.module.ts',
    '!src/infra/database/prisma.service.ts'
  ],
  // The pure rules of an integration are where a silent mistake costs money,
  // so they carry the strict threshold.
  coverageThreshold: {
    './src/modules/kuantokusta/domain/': {
      branches: 90,
      functions: 100,
      lines: 100,
      statements: 95
    }
  },
  transform: {
    '^.+\\.(t|j)sx?$': '@swc/jest'
  },
  moduleNameMapper: {
    // SWC writes imports with the .js extension Node needs at runtime; Jest
    // resolves the TypeScript source, so the extension is dropped here.
    '^(\\.{1,2}/.*)\\.js$': '$1'
  }
})
