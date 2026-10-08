import { defineConfig } from 'jest'

// Integration tests: need a real PostgreSQL with the migrations applied.
// See README, "Tests".
export default defineConfig({
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  extensionsToTreatAsEsm: ['.ts'],
  testMatch: ['<rootDir>/tests/integration/**/*.int.spec.ts'],
  testTimeout: 20000,
  transform: {
    '^.+\\.(t|j)sx?$': '@swc/jest'
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  }
})
