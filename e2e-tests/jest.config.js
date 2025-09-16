export default {
  preset: 'ts-jest/presets/default-esm',
  extensionsToTreatAsEsm: ['.ts'],
  testEnvironment: 'node',
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^webmq-frontend$': '<rootDir>/../packages/frontend/src/index.ts',
    '^webmq-backend$': '<rootDir>/../packages/backend/src/index.ts'
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      useESM: true,
      tsconfig: {
        noImplicitAny: false,
        strict: false
      }
    }],
  },
  transformIgnorePatterns: [
    'node_modules/(?!(webmq-frontend|webmq-backend)/)'
  ],
  testMatch: ['**/*.test.ts'],
  testTimeout: 60000, // 60 seconds for container startup
  maxConcurrency: 1, // Run tests sequentially to avoid port conflicts
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js']
};