// Playwright-style end-to-end spec — search returns matching products.
// Self-contained: no cross-node imports (keeps relation-conformance silent).

declare const test: (name: string, fn: (args: { page: Page }) => Promise<void>) => void;
declare const expect: (actual: unknown) => { toContainText(text: string): Promise<void> };
interface Page {
  goto(url: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  press(selector: string, key: string): Promise<void>;
  locator(selector: string): unknown;
}

test('search returns matching products', async ({ page }) => {
  await page.goto('/');
  await page.fill('#search', 'widget');
  await page.press('#search', 'Enter');
  await expect(page.locator('#results')).toContainText('widget');
});
