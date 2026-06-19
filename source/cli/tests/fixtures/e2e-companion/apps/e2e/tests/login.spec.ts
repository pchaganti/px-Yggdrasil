// Playwright-style end-to-end spec — login with valid credentials.
// Self-contained: no cross-node imports (keeps relation-conformance silent).

declare const test: (name: string, fn: (args: { page: Page }) => Promise<void>) => void;
declare const expect: (actual: unknown) => { toHaveURL(url: string): Promise<void> };
interface Page {
  goto(url: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
}

test('login with valid credentials', async ({ page }) => {
  await page.goto('/login');
  await page.fill('#email', 'user@example.com');
  await page.fill('#password', 'correct horse battery staple');
  await page.click('text=Sign in');
  await expect(page).toHaveURL('/dashboard');
});
