import { test as base, expect, Page } from '@playwright/test';
import { signIn, clearAuthStorage } from './auth';
import { cleanTestWorkspace } from './supabase';

/**
 * Extended test fixture that:
 *  - Cleans the test workspace in Supabase before each test
 *  - Navigates to the app
 *  - Signs in as the test user
 *  - Yields a fully-initialized page to the test
 */
type Fixtures = {
  authedPage: Page;
};

export const test = base.extend<Fixtures>({
  authedPage: async ({ page, baseURL }, use) => {
    // Clean DB before each test
    await cleanTestWorkspace();

    // Navigate. baseURL already points at either file://, http://, or https://.
    // For file://, baseURL IS the full URL to index.html.
    // For http(s)://, we need to append the path.
    const target = baseURL!;
    if (target.startsWith('file://')) {
      await page.goto(target);
    } else if (target.endsWith('/')) {
      await page.goto(target + 'index.html');
    } else {
      await page.goto(target + '/index.html');
    }

    // Clear any stale auth state in the browser
    await clearAuthStorage(page);
    await page.reload();

    // Sign in
    await signIn(
      page,
      process.env.TEST_USER_EMAIL!,
      process.env.TEST_USER_PASSWORD!
    );

    await use(page);
  },
});

export { expect };
