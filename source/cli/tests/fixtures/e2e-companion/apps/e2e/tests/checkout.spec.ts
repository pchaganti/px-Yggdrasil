// Playwright-style end-to-end spec — checkout happy path.
// Self-contained: no cross-node imports (keeps relation-conformance silent).

declare const test: (name: string, fn: (args: { page: Page }) => Promise<void>) => void;
declare const expect: (actual: unknown) => { toBeVisible(): Promise<void> };
interface Page {
  goto(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  locator(selector: string): unknown;
}

test('checkout happy path', async ({ page }) => {
  await page.goto('/cart');
  await page.click('text=Checkout');
  await page.fill('#shipping-address', '1 Test Street');
  await page.click('text=Confirm order');
  await expect(page.locator('#order-confirmation')).toBeVisible();
});
