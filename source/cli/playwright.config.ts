/*
 * Playwright config — the portal e2e gate (Chromium, public CLI surface only).
 *
 * Drives the REAL `yg portal` output of REAL on-disk fixture projects in a real Chromium
 * browser. testDir is the dedicated portal-e2e tree, kept OUT of the vitest collector
 * (vitest.config.ts excludes tests/portal-e2e/**), so the two runners never fight over the
 * same files. Reporter is the terminal 'list' so a CI log reads cleanly; artifacts land under
 * a gitignored dir. Fully offline — every page is a file:// static export or a 127.0.0.1
 * loopback server the spec spawns itself.
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/portal-e2e',
  // Portal generation + Chromium nav is not free; give each test room without hanging CI.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // No webServer here: each spec spawns its own static page (file://) or loopback server,
  // always against a real fixture project, and tears it down — see support/harness.ts.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: '.playwright/report' }]] : 'list',
  outputDir: '.playwright/results',
  use: {
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
