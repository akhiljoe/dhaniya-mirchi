import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/*.test.ts'], // unit only; integration has its own config
  },
});
