import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    // Booting a real Cordis composition per suite is slower than a unit test but
    // still well under this; a hang here means a fiber never settled.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
