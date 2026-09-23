import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.system.test.ts', 'src/**/*.live.test.ts'],
        },
      },
      {
        test: {
          name: 'system',
          environment: 'node',
          include: ['src/**/*.system.test.ts'],
          // WHY serial: system tests bind Unix sockets, write real session
          // files and tail them. Running them in parallel makes a socket or
          // timing collision look like a product failure.
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // WHY every source file is in the denominator: imported-files-only
      // coverage rewards untested modules by leaving them out of the total.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      // WHY these floors: the first complete Node 24 coverage run (2026-09-22,
      // after Stage 3) measured 86.07% statements, 71.94% branches, 82.67%
      // functions and 90.68% lines over every source file, testing helpers
      // included. Whole percentages just below that baseline catch
      // backsliding without treating a rounding digit as a regression; ratchet
      // only from a real full run, like the siblings. The live tier (real pi)
      // is not part of this run, which is why the bridge's reconnect timers
      // and the launch paths only the real process reaches stay uncovered.
      thresholds: { statements: 85, branches: 71, functions: 82, lines: 90 },
    },
  },
})
