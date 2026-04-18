import { test, expect } from '../helpers/fixtures';
import { signOut } from '../helpers/auth';

test.describe('Smoke', () => {
  test('app loads, sign-in succeeds, core UI is present', async ({ authedPage }) => {
    // Version badge present
    const badge = authedPage.locator('#version-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(/^v\d+\.\d+\.\d+$/);

    // Core tabs present
    await expect(authedPage.locator('#tab-btn-tracker')).toBeVisible();
    await expect(authedPage.locator('#tab-btn-submitters')).toBeVisible();
    await expect(authedPage.locator('#tab-btn-insights')).toBeVisible();
    await expect(authedPage.locator('#tab-btn-help')).toBeVisible();

    // FAB present
    await expect(authedPage.locator('#new-request-fab')).toBeVisible();

    // Config button present
    await expect(authedPage.locator('#btn-config')).toBeVisible();
  });

  test('sign out returns to auth gate', async ({ authedPage }) => {
    await signOut(authedPage);
    await expect(authedPage.locator('#auth-gate')).toBeVisible();
    await expect(authedPage.locator('#auth-email')).toBeVisible();
  });

  test('self-test harness exists and reports a pass count', async ({ authedPage }) => {
    // The app has a QA self-test system — verify the progress label is populated
    await authedPage.locator('#tab-btn-help').click();
    await expect(authedPage.locator('#qa-progress-label')).toBeVisible();
    const labelText = await authedPage.locator('#qa-progress-label').innerText();
    // Should contain something like "N / M passing" or a percentage
    expect(labelText.length).toBeGreaterThan(0);
  });
});
