import { test, expect, resolvePortalURL } from '../helpers/portal';
import type { Page } from '@playwright/test';

/**
 * v1.11.0 / portal v0.5.0 — Date field type with min-days constraint.
 *
 * The portal renders date fields as <input type="date"> with the `min`
 * attribute set to today + N days when the workspace_config defines
 * a `min_days_from_now` for the field. Submit-time JS validation
 * re-checks in case the rep bypasses the picker (DevTools, etc.).
 *
 * These tests are mocked-portal style (matching portal-submit-b2b)
 * because the portal's WORKSPACE_ID is hardcoded to production. We
 * mock workspace_config GET and projects POST; we never write to a
 * real workspace.
 *
 * What this covers:
 *  1. Date input renders with `min` attribute = today + N days
 *  2. Submit with a date inside the minimum window is rejected with
 *     a clear error AND no INSERT lands
 */

/** Compute YYYY-MM-DD for today + offsetDays. Calendar days. */
function dateOffset(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

const FIXTURE_CONFIG = {
  criteria: [
    {
      id: 'crit1',
      label: 'Revenue potential',
      hint: '',
      options: [
        { label: 'Low', score: 2 },
        { label: 'High', score: 10 },
      ],
    },
  ],
  detail_fields: [
    { id: 'date1', type: 'date', label: 'Requested delivery date', required: true, min_days_from_now: 2 },
  ],
  project_type_mappings: [
    { id: 'pt1', label: 'New feature', presetKey: null, activeCriteriaIds: [] },
  ],
  custom_presets: [],
  weights: { crit1: 1.0 },
  tier_thresholds: { pursue: 75, evaluate: 55, defer: 35 },
};

/** Set up a signed-in portal with a date detail field configured. */
async function setupPortalWithDateField(
  page: Page,
  baseURL: string,
  options: {
    projectsInsertHandler?: (body: any) => { status: number; body: any };
  } = {}
) {
  const url = resolvePortalURL(baseURL);
  await page.goto(url);

  await page.evaluate(() => {
    const session = {
      access_token: 'fake-access-token-' + Date.now(),
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: 'fake-refresh-token',
      user: {
        id: '00000000-0000-0000-0000-000000000000',
        aud: 'authenticated',
        role: 'authenticated',
        email: 'test-rep@arbiter.test',
      },
    };
    localStorage.setItem('sb-arbiter-portal-auth', JSON.stringify(session));
  });

  await page.route('**/rest/v1/workspace_config**', async (route, request) => {
    if (request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([FIXTURE_CONFIG]),
      });
    } else {
      await route.continue();
    }
  });

  await page.route('**/rest/v1/projects**', async (route, request) => {
    const method = request.method();
    if (method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    } else if (method === 'POST') {
      const body = JSON.parse(request.postData() || '{}');
      const handler = options.projectsInsertHandler;
      const response = handler ? handler(body) : {
        status: 201,
        body: [{ ...body, id: 'fake-' + Date.now(), created_at: new Date().toISOString() }],
      };
      await route.fulfill({
        status: response.status,
        contentType: 'application/json',
        body: JSON.stringify(response.body),
      });
    } else {
      await route.continue();
    }
  });

  await page.reload();
  await expect(page.locator('#view-signed-in')).toBeVisible({ timeout: 5_000 });
}

test.describe('v1.11.0 — Date field type with min-days constraint', () => {
  test('Date input renders with min attribute set to today + N days', async ({ page, baseURL }) => {
    await setupPortalWithDateField(page, baseURL!);

    // Open the form
    await page.locator('button', { hasText: /Submit a request/i }).first().click();
    await expect(page.locator('#sub-form')).toBeVisible();

    // Date input should exist with the right type and min attribute.
    // The fixture sets min_days_from_now: 2, so min should be today + 2 days.
    const dateInput = page.locator('#df-date1');
    await expect(dateInput).toBeVisible();
    await expect(dateInput).toHaveAttribute('type', 'date');
    const expectedMin = dateOffset(2);
    await expect(dateInput).toHaveAttribute('min', expectedMin);
  });

  test('Submit with a date inside the minimum window is rejected; no INSERT', async ({ page, baseURL }) => {
    let insertCount = 0;
    await setupPortalWithDateField(page, baseURL!, {
      projectsInsertHandler: (body) => {
        insertCount++;
        return { status: 201, body: [{ ...body, id: 'fake-' + Date.now() }] };
      },
    });

    // Open the form
    await page.locator('button', { hasText: /Submit a request/i }).first().click();
    await expect(page.locator('#sub-form')).toBeVisible();

    // Fill all required fields with valid values
    await page.locator('#form-project-type').selectOption('pt1');
    await page.locator('#df-__name__').fill('Test project');
    await page.locator('#df-__customer__').fill('Test customer');
    await page.locator('#df-__submitter__').fill('Test submitter');
    // Email is auto-filled from session

    // Manually set the date input value to TODAY (which is < today + 2 days).
    // Direct value assignment bypasses the picker's min-attribute restriction
    // exactly the way a determined rep with DevTools could.
    const today = dateOffset(0);
    await page.evaluate((val) => {
      const el = document.getElementById('df-date1') as HTMLInputElement;
      el.value = val;
    }, today);

    // Answer the criterion
    await page.locator('#dd-crit1').selectOption({ index: 1 }); // pick "Low" (index 0 is blank, 1 is first option)

    // Submit
    await page.locator('#btn-submit-request').click();

    // Error should appear with the right message
    const status = page.locator('#form-submit-status');
    await expect(status).toBeVisible({ timeout: 3_000 });
    await expect(status).toContainText(/Requested delivery date must be at least 2 days from today/i);

    // And no INSERT should have happened
    // Give the network handler a moment to fire if it were going to
    await page.waitForTimeout(500);
    expect(insertCount).toBe(0);
  });
});
