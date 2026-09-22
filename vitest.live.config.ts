import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.live.test.ts'],
    // WHY a long timeout only here: a live test boots the real Pi TUI in a
    // sandbox and waits for scripted turns. Deterministic suites keep the
    // default so a hang there is still reported quickly.
    testTimeout: 180_000,
  },
})
