/*
 * §3a SHELL-top loop + OV-approve — the SERVED page: Refresh, Approve, cost preview, view-only.
 *
 * Drives the REAL loopback portal server (spawned `yg portal --port 0` over a FRESH temp copy of
 * the portal-basic fixture) in Chromium. This is the only way the write paths are honest: Approve
 * re-enters the running bin (process.argv[1] is the yg bin), so the dry-run cost preview and the
 * real fill genuinely run the CLI, never a stub.
 *
 *   - shell-refresh : Refresh re-fetches /data and writes NOTHING (the committed lock is byte-equal
 *                     before/after); the page re-renders from the fresh data.
 *   - ov-approve    : the Approve flow shows the dry-run cost preview FIRST (reviewer-call budget),
 *                     then — confirmed — runs the deterministic fill via the spawned CLI, and the
 *                     next data reflects it (the fixture goes all-green: 0 unverified).
 *   - shell-approve : the write control is enabled in a live (write-enabled) page; with --no-write
 *                     it is DISABLED, and a stray POST /approve is rejected 409.
 *
 * Always tears down (server killed, temp dir removed) via the worker Teardown fixture. Public
 * surface only — spawns dist/bin.js, drives the rendered page + reads the committed file it wrote;
 * no fabricated PortalData. COVERS is read by portal/every-surface-has-e2e.
 */
import { test, expect } from './support/fixtures';
import { servedPortal, freshFixtureCopy } from './support/harness';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const COVERS = ['shell-refresh', 'shell-approve', 'ov-approve'];

test.describe('§3a SHELL-top — Refresh (read-only) + Approve (the one write)', () => {
  test('Refresh re-fetches /data and writes nothing; Approve runs the fill and goes all-green', async ({
    page,
    t,
  }) => {
    const project = freshFixtureCopy(t, 'portal-basic');
    const { baseUrl } = await servedPortal(t, { cwd: project });
    await page.goto(baseUrl + '/');

    // The served page is live + write-enabled: Refresh is enabled (disabled only on a static page).
    const refresh = page.locator('.topbar-refresh');
    await expect(refresh).toBeEnabled();
    const approve = page.locator('.topbar-approve');
    await expect(approve).toBeEnabled();

    // Snapshot the committed lock before any action (Refresh must not touch it).
    const committedLock = path.join(project, '.yggdrasil', 'yg-lock.nondeterministic.json');
    const lockBefore = existsSync(committedLock)
      ? { bytes: readFileSync(committedLock, 'utf-8'), mtimeMs: statSync(committedLock).mtimeMs }
      : null;

    // Refresh: re-runs the free checks read-only and re-renders. The freshness pill reflects it.
    await refresh.click();
    await expect(page.locator('.topbar-live')).toContainText(/Refreshed|re-checked/i);
    if (lockBefore) {
      const lockAfter = readFileSync(committedLock, 'utf-8');
      expect(lockAfter, 'Refresh must not write the committed lock').toBe(lockBefore.bytes);
    }

    // Before Approve the fixture is all-unverified: the overview verdict says so.
    await page.goto(baseUrl + '/#/view/overview');
    await expect(page.locator('.ov-verdict')).toContainText('waiting to be checked');

    // OV-approve: the dry-run cost preview fires via window.confirm. Accept it; assert the
    // confirm text carries the engine's reviewer-call budget (never a blanket claim).
    let confirmText = '';
    page.on('dialog', async (dialog) => {
      confirmText = dialog.message();
      await dialog.accept();
    });
    await page.locator('.topbar-approve').click();
    // The confirm dialog showed a pending-check / reviewer-call budget.
    await expect.poll(() => confirmText).toContain('reviewer call');
    // After the deterministic fill + the re-extract, the page reflects the new truth: all-green.
    await expect(page.locator('.topbar-live')).toContainText(/Approved|re-checked/i, { timeout: 60_000 });
    await page.goto(baseUrl + '/#/view/coverage');
    // The verified segment now exists and the unverified segment is gone (0 unverified).
    await expect(page.locator('.cov-bar .cov-seg-v')).toHaveCount(1);
    await expect(page.locator('.cov-bar .cov-seg-u')).toHaveCount(0);

    // The deterministic fill wrote only the gitignored cache, never the committed lock.
    const detCache = path.join(project, '.yggdrasil', '.yg-lock.deterministic.json');
    expect(existsSync(detCache)).toBe(true);
    if (lockBefore) {
      expect(readFileSync(committedLock, 'utf-8')).toBe(lockBefore.bytes);
    }
  });

  test('--no-write view-only mode disables the write control and rejects a stray POST 409', async ({ page, t }) => {
    const project = freshFixtureCopy(t, 'portal-basic');
    const { baseUrl } = await servedPortal(t, { cwd: project, noWrite: true });
    await page.goto(baseUrl + '/');

    // The Approve control is disabled in view-only mode.
    await expect(page.locator('.topbar-approve')).toBeDisabled();
    // The brand sub + live pill announce view-only.
    await expect(page.locator('.rail-brand-sub')).toHaveText('view-only');

    // A stray POST /approve is rejected with 409 by the server (the server's own guard).
    const res = await page.request.post(baseUrl + '/approve', {
      data: { llm: false },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(409);
  });
});
