import { Page, expect } from '@playwright/test';

/**
 * Sign in via the UI and wait for the post-auth init to complete.
 * Relies on the [Arbiter] Post-auth init complete console log added in v1.9.1.
 */
export async function signIn(page: Page, email: string, password: string) {
  const initComplete = page.waitForEvent('console', {
    predicate: msg => msg.text().includes('Post-auth init complete'),
    timeout: 15_000,
  });

  await page.fill('#auth-email', email);
  await page.fill('#auth-password', password);
  await page.click('#signin-btn');

  await initComplete;

  // Sanity: auth gate should be hidden, app should be visible
  await expect(page.locator('#auth-gate')).toBeHidden();
  await expect(page.locator('.app')).toBeVisible();
}

/** Sign out via Settings drawer → Settings tab → Sign out button. */
export async function signOut(page: Page) {
  const signedOut = page.waitForEvent('console', {
    predicate: msg => msg.text().includes('Auth event: SIGNED_OUT'),
    timeout: 10_000,
  });

  await openSettingsTab(page);

  // Sign-out button lives in the Account section of the Settings tab.
  // Scroll it into view because the settings tab is long.
  const signoutBtn = page.locator('#btn-signout');
  await signoutBtn.scrollIntoViewIfNeeded();
  await signoutBtn.click();

  await signedOut;
  await expect(page.locator('#auth-gate')).toBeVisible();
}

/**
 * Navigate to the Settings tab (where sign-out, sample data, backups live).
 * Flow: click gear → drawer opens → click "Settings" → drawer closes, #tab-settings becomes active.
 */
export async function openSettingsTab(page: Page) {
  await page.locator('#btn-config').click();
  await page.locator('#config-drawer').waitFor({ state: 'visible' });
  await page.locator('#config-drawer').getByRole('button', { name: /settings/i }).click();
  await page.locator('#tab-settings').waitFor({ state: 'visible' });
}

/**
 * Navigate to the Reps tab. Internal tab id is still tab-submitters
 * (renamed display-only in C.3.a); the button id is tab-btn-submitters.
 *
 * If expectedRepCount is provided, waits for window.reps to have that many
 * entries before clicking the tab. This guards against the race where
 * loadReps() hasn't resolved yet by the time we navigate.
 */
export async function openRepsTab(page: Page, expectedRepCount?: number) {
  if (typeof expectedRepCount === 'number') {
    await page.waitForFunction(
      (n) => Array.isArray((window as any).reps) && (window as any).reps.length === n,
      expectedRepCount,
      { timeout: 10_000 }
    );
  }
  await page.locator('#tab-btn-submitters').click();
  await page.locator('#tab-submitters').waitFor({ state: 'visible' });
}

/**
 * For file:// tests where the app reads credentials from localStorage (Supabase SDK),
 * ensure we start from a clean slate.
 */
export async function clearAuthStorage(page: Page) {
  await page.evaluate(() => {
    Object.keys(localStorage)
      .filter(k => k.startsWith('sb-') || k.startsWith('arbiter'))
      .forEach(k => localStorage.removeItem(k));
  });
}
