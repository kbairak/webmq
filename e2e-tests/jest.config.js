export default {
  preset: 'ts-jest/presets/default-esm',
  extensionsToTreatAsEsm: ['.ts'],
  testEnvironment: 'node',
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^webmq-frontend$': '<rootDir>/../packages/frontend/src/index.ts',
    '^webmq-backend$': '<rootDir>/../packages/backend/src/index.ts',
    '^amqplib$': '<rootDir>/src/mock-amqp.ts'
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
  testTimeout: 30000, // Reduced timeout since no containers
  maxConcurrency: 1, // Run tests sequentially to avoid port conflicts
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  globalSetup: '<rootDir>/src/global-setup.ts',
  globalTeardown: '<rootDir>/src/global-teardown.ts',
  forceExit: true, // Force exit after tests complete
  detectOpenHandles: true // Detect open handles
};