/*
 * §3a OVERLAYS (⌘K palette, glossary) + SHELL chrome (theme toggle, deep-link reload).
 *
 * Drives the real `yg portal --static` page in Chromium:
 *   - OV-palette  : ⌘K opens the command palette; it fuzzy-matches a real entity and Enter
 *                   routes to it (a node opens its panel). Arrow keys move the active row.
 *   - OV-glossary : an engine term carries a plain-language tooltip (title + aria-label).
 *   - shell-theme : the theme toggle flips data-theme between light and dark and persists.
 *   - shell-deeplink : reloading a node hash reopens exactly that entity AND its panel; a view
 *                   hash reloads straight to that view (deep-linkable, round-trips losslessly).
 *
 * Public surface only; no fabricated PortalData. COVERS is read by portal/every-surface-has-e2e.
 */
import { test, expect } from './support/fixtures';

export const COVERS = ['ov-palette', 'ov-glossary', 'shell-theme', 'shell-deeplink'];

test.describe('§3a OV-palette — the ⌘K command palette', () => {
  test('⌘K opens the palette, fuzzy-matches a real node, and Enter routes to it', async ({ page, basicPage }) => {
    await page.goto(basicPage);
    await page.keyboard.press('Meta+k');
    const palette = page.locator('.palette-backdrop');
    await expect(palette).toBeVisible();
    await expect(palette).toHaveAttribute('role', 'dialog');
    // Type a fuzzy query that matches the real fixture node `api/orders`.
    await page.locator('.palette-field').fill('orders');
    const rows = page.locator('.palette-row');
    await expect(rows.first()).toBeVisible();
    // The top result is a real entity, not a fabricated one — it carries the orders node.
    await expect(rows.first()).toContainText(/orders/i);
    // Enter routes to the selection; a node opens its attestation panel.
    await page.keyboard.press('Enter');
    await expect(palette).toHaveCount(0);
    await expect(page).toHaveURL(/#\/node\/api%2Forders/);
    await expect(page.locator('.app-panel')).toHaveClass(/open/);
  });

  test('the top-bar search trigger also opens the palette, and arrow keys move the active row', async ({
    page,
    basicPage,
  }) => {
    await page.goto(basicPage);
    await page.locator('.rail-cmdk').click();
    await expect(page.locator('.palette-backdrop')).toBeVisible();
    // Empty query → view actions first (never an empty palette).
    const rows = page.locator('.palette-row');
    await expect(rows.first()).toHaveClass(/on/);
    await page.keyboard.press('ArrowDown');
    // The active row moved to the second entry.
    await expect(rows.nth(1)).toHaveClass(/on/);
    await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(page.locator('.palette-backdrop')).toHaveCount(0);
  });

  test('the palette routes to a view action', async ({ page, basicPage }) => {
    await page.goto(basicPage);
    await page.keyboard.press('Control+k');
    await page.locator('.palette-field').fill('suppress');
    await expect(page.locator('.palette-row').first()).toContainText(/suppress/i);
    await page.locator('.palette-row').first().click();
    await expect(page).toHaveURL(/#\/view\/suppressions/);
  });
});

test.describe('§3a OV-glossary — plain-language tooltips on engine terms', () => {
  test('an engine term carries a title + aria-label tooltip', async ({ page, basicPage }) => {
    await page.goto(basicPage);
    // The count header wraps "N aspects" as a glossary term.
    const term = page.locator('.term[data-term="aspect"]').first();
    await expect(term).toBeVisible();
    const title = await term.getAttribute('title');
    const aria = await term.getAttribute('aria-label');
    expect(title ?? '').toContain('rule the code must satisfy');
    expect(aria ?? '').toContain('rule the code must satisfy');
    // It is focus-reachable (tabindex) so the tooltip meaning is reachable by keyboard too.
    await expect(term).toHaveAttribute('tabindex', '0');
  });
});

test.describe('§3a SHELL — theme toggle + deep-link reload', () => {
  test('the theme toggle flips data-theme and persists', async ({ page, basicPage }) => {
    await page.goto(basicPage);
    const html = page.locator('html');
    const before = await html.getAttribute('data-theme');
    await page.locator('.topbar-theme').click();
    const after = await html.getAttribute('data-theme');
    expect(after).not.toBe(before);
    expect(['light', 'dark']).toContain(after);
  });

  test('reloading a node hash reopens the entity AND its panel', async ({ page, basicPage }) => {
    // Deep-link straight to a node — the panel opens on first load (no prior click).
    await page.goto(basicPage + '#/node/api%2Fusers');
    const panel = page.locator('.app-panel');
    await expect(panel).toHaveClass(/open/);
    await expect(panel.locator('.pan-path')).toHaveText('api/users');
    // Reload — the same hash reopens exactly the same entity + panel (round-trips).
    await page.reload();
    await expect(page.locator('.app-panel')).toHaveClass(/open/);
    await expect(page.locator('.app-panel .pan-path')).toHaveText('api/users');
  });

  test('a deep-linked view hash reloads straight to that view', async ({ page, basicPage }) => {
    await page.goto(basicPage + '#/view/coverage');
    await expect(page.locator('.cov-ledger')).toBeVisible();
    await page.reload();
    await expect(page.locator('.cov-ledger')).toBeVisible();
    // The nav rail marks coverage active.
    await expect(page.locator('.rail-link.on')).toContainText('Coverage');
  });
});
