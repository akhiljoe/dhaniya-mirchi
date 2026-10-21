import { defineConfig } from 'vitest/config';

// Integration tests run against the compose Postgres (docker compose up -d
// postgres), in a separate `dhaniya_test` database. Sequential: they share it.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    fileParallelism: false,
  },
});
