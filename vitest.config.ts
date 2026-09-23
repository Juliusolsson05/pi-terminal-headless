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
      // Floors are set from the first complete run in Task 4 (like the
      // siblings: whole percentages just below the measured baseline), never
      // guessed up front.
    },
  },
})
