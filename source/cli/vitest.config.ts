import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.external.test.ts',
      // Fixture mini-repos contain *.spec.ts / *.test.ts files as DATA (e.g. the
      // companion fixture's paired Playwright specs), not tests to run — never
      // collect them.
      '**/tests/fixtures/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/bin.ts',
        'src/templates/**',
        'src/cli/**', // thin Commander.js wrappers — tested via E2E subprocess
        'src/model/**', // type-only definitions — no runtime code
        'src/core/graph-from-git.ts', // git/archive — try/catch branches hard to cover
        'src/core/graph-loader.ts', // loadAspects/Flows/Schemas — catch on missing dirs
        'src/llm/**', // LLM providers — external API calls not covered in unit tests
      ],
      // Aligned with the repo-check.sh coverage gate (>= 90% on every metric).
      // The previous values (85/90/69/82) sat far below the real gate, so a
      // genuine coverage regression could pass `vitest run` yet fail repo-check;
      // mirroring the gate here fails the test run itself at the same threshold.
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});
