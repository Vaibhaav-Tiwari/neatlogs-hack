import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{schema,engine,cli,adapters,agent}/**/*.test.ts'],
  },
});
