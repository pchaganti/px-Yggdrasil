/*
 * ACCESSIBILITY in the real browser (Chromium) — concrete a11y properties asserted directly.
 *
 * The portal is for a human auditor, including one using a keyboard or a screen reader. This
 * spec asserts the concrete a11y contract on the REAL `yg portal --static` page:
 *   - ARIA on the verdict bar: the Coverage bar is role="group" with a text aria-label stating
 *     the verified-of-total figure (a screen reader hears the verdict, not just a coloured bar).
 *   - Canvas matrix DOM-list MIRROR: the dense allowed-relations Canvas (the one place Canvas is
 *     sanctioned) carries a DOM-list mirror, so the matrix is not opaque to a screen reader.
 *   - keyboard-only traversal reaches every interactive control: Tab moves focus through the
 *     nav rail, the top-bar actions, and into the stage's interactive elements — no control is
 *     mouse-only (every interactive element is a native focusable button/link/input).
 *   - prefers-reduced-motion honoured: with the media feature emulated, animated transitions
 *     collapse to 0s (the page respects the OS reduce-motion setting).
 *   - state is never conveyed by colour alone: every state badge carries a glyph + aria-label.
 *
 * Public surface only; no fabricated PortalData. COVERS adds no manifest surface — it hardens
 * the surfaces other specs already claim.
 */
import { test, expect } from './support/fixtures';

export const COVERS: string[] = [];

test.describe('accessibility — ARIA, keyboard, Canvas mirror, reduced-motion', () => {
  test('the verdict bar is an ARIA group with a text label (not colour-only)', async ({ page, basicPage }) => {
    await page.goto(basicPage + '#/view/coverage');
    const bar = page.locator('.cov-bar');
    await expect(bar).toHaveAttribute('role', 'group');
    const label = await bar.getAttribute('aria-label');
    expect(label ?? '').toMatch(/verified \d+ of \d+ expected pairs/);
  });

  test('every honest-state badge carries a glyph AND an aria-label (state never colour-only)', async ({
    page,
    basicPage,
  }) => {
    await page.goto(basicPage);
    // The legend renders all nine states; each badge is role="img" with an aria-label.
    const badges = page.locator('.legend .state-glyph');
    await expect(badges).toHaveCount(9);
    const count = await badges.count();
    for (let i = 0; i < count; i += 1) {
      const b = badges.nth(i);
      await expect(b).toHaveAttribute('role', 'img');
      const aria = await b.getAttribute('aria-label');
      expect((aria ?? '').length, 'each state badge has a non-empty aria-label').toBeGreaterThan(0);
      const glyph = (await b.textContent()) ?? '';
      expect(glyph.trim().length, 'each state badge has a glyph (not colour alone)').toBeGreaterThan(0);
    }
  });

  test('the Canvas allowed-relations matrix carries a DOM-list mirror', async ({ page, repoPage }) => {
    await page.goto(repoPage + '#/view/relations');
    // The dense grid is Canvas; its mirror is a real DOM list, screen-reader legible.
    await expect(page.locator('canvas.mtx-canvas')).toHaveCount(1);
    const mirror = page.locator('.mtx-mirror');
    await expect(mirror).toBeVisible();
    await expect(mirror).toHaveAttribute('aria-label', /Allowed relations/i);
    await expect(mirror.locator('.mtx-mirror-row')).not.toHaveCount(0);
    // The Canvas itself is role="img" with a label pointing at the mirror (never a bare canvas).
    await expect(page.locator('canvas.mtx-canvas')).toHaveAttribute('role', 'img');
  });

  test('keyboard-only traversal reaches the nav rail, top-bar actions, and stage controls', async ({
    page,
    basicPage,
  }) => {
    await page.goto(basicPage + '#/view/coverage');
    // Tab repeatedly and collect the focused element each step; assert the key controls are hit.
    const reached = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press('Tab');
      const sig = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return '';
        // A stable signature: tag + the full class list (so a control with a shared `btn`
        // base class still exposes its specific `topbar-refresh` / `topbar-approve` class).
        const cls = (el.className || '').toString().trim().replace(/\s+/g, '.');
        return el.tagName.toLowerCase() + (cls ? '.' + cls : '');
      });
      if (sig) reached.add(sig);
    }
    const joined = [...reached].join(' | ');
    // The nav-rail links, the ⌘K trigger, the refresh/approve/theme buttons, and a stage
    // control (a worklist deep-link or rule header) are all keyboard-focusable.
    expect(joined, joined).toMatch(/rail-link|rail-cmdk/);
    expect(joined, joined).toMatch(/topbar-(refresh|approve|theme|search)/);
    expect(joined, joined).toMatch(/cov-(deeplink|rulehdr|jump|live-btn)|exp-btn/);
    // Every focused element is a native interactive element (button / a / input) — never a
    // mouse-only div with a click handler.
    const nonNative = await page.evaluate(() => {
      const interactive = ['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'];
      // Spot-check: focus each visible .rail-link, .btn, .cov-deeplink — all must be native.
      const sample = Array.from(
        document.querySelectorAll('.rail-link, .btn, .cov-deeplink, .cov-rulehdr, .exp-btn'),
      );
      return sample.filter((el) => !interactive.includes(el.tagName)).length;
    });
    expect(nonNative, 'all sampled interactive controls are native focusable elements').toBe(0);
  });

  test('prefers-reduced-motion: reduce collapses transitions to 0s', async ({ page, basicPage }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(basicPage);
    // The panel slot is animated by default; under reduce it must have no transition.
    await page.goto(basicPage + '#/node/api%2Forders');
    const dur = await page.evaluate(() => {
      const el = document.querySelector('.app-panel');
      if (!el) return null;
      return getComputedStyle(el).transitionDuration;
    });
    // Every transition-duration collapses to 0s under the reduce media feature.
    expect(dur).toBe('0s');
  });
});
