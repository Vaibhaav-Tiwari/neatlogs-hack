import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{schema,engine,cli,adapters,agent,onboarding}/**/*.test.ts'],
    setupFiles: ['test/real-runs-guard.ts'],
  },
});
