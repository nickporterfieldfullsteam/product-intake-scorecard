import { test, expect, resolvePortalURL } from '../helpers/portal';

/**
 * Phase 3 Step B.2.b — Portal submit flow.
 *
 * Scope: the portal's form-submission path. We mock both:
 *   - GET /rest/v1/workspace_config → returns a fixture config with
 *     project types, detail fields, criteria, weights, thresholds
 *   - POST /rest/v1/projects → captures the submitted payload and
 *     returns a fake "saved" row
 *
 * We do NOT use a real Supabase connection here because the portal's
 * WORKSPACE_ID is hardcoded to production. Mocking keeps tests
 * hermetic and ensures we don't accidentally write test rows to the
 * real workspace. Real integration can be added later with a
 * parameterized workspace ID.
 *
 * What this covers:
 *  1. Form populates from mocked workspace_config
 *  2. Validation: missing required locked field blocks submit
 *  3. Validation: unanswered criteria blocks submit
 *  4. Well-formed submit: correct payload shape, score, tier, email
 *  5. Post-submit: form resets, submissions list refreshes, toast shows
 */

/** Fixture config — small but realistic. */
const FIXTURE_CONFIG = {
  criteria: [
    {
      id: 'crit1',
      label: 'Revenue potential',
      hint: 'Annual contract value',
      options: [
        { label: 'Low (<$10k)',  score: 2 },
        { label: 'Medium ($10-50k)', score: 6 },
        { label: 'High (>$50k)', score: 10 },
      ],
    },
    {
      id: 'crit2',
      label: 'Effort',
      hint: 'Engineering lift required',
      options: [
        { label: 'Small', score: 10 },
        { label: 'Medium', score: 6 },
        { label: 'Large', score: 2 },
      ],
    },
  ],
  detail_fields: [
    { id: 'det1', type: 'textarea', label: 'Description', required: true, placeholder: 'What is this?' },
    { id: 'det2', type: 'text', label: 'Deadline', required: false, placeholder: 'Q3 2026' },
  ],
  project_type_mappings: [
    { id: 'pt1', label: 'New feature', presetKey: null, activeCriteriaIds: [] },
  ],
  custom_presets: [],
  weights: {
    crit1: 2.0,
    crit2: 1.0,
  },
  tier_thresholds: {
    pursue: 75,
    evaluate: 55,
    defer: 35,
  },
};

/** Seed a signed-in session + mock workspace_config GET + optional projects mocks. */
async function setupSignedInPortal(
  page: import('@playwright/test').Page,
  baseURL: string,
  options: {
    projectsInsertHandler?: (body: any) => { status: number; body: any };
    projectsListHandler?: () => { status: number; body: any };
  } = {}
) {
  const url = resolvePortalURL(baseURL);
  await page.goto(url);

  // Seed a session
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

  // Mock workspace_config GET
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

  // Mock projects endpoint — GET returns empty list by default, POST captured
  await page.route('**/rest/v1/projects**', async (route, request) => {
    const method = request.method();
    if (method === 'GET') {
      const handler = options.projectsListHandler;
      const response = handler ? handler() : { status: 200, body: [] };
      await route.fulfill({
        status: response.status,
        contentType: 'application/json',
        body: JSON.stringify(response.body),
      });
    } else if (method === 'POST') {
      const bodyText = request.postData() || '{}';
      const body = JSON.parse(bodyText);
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

  // Reload so the portal's init() runs with session + mocked config
  await page.reload();
  await expect(page.locator('#view-signed-in')).toBeVisible({ timeout: 5_000 });
}

test.describe('Phase 3 B.2.b — Portal submit flow', () => {
  test('Form populates from workspace_config on dashboard open', async ({ page, baseURL }) => {
    await setupSignedInPortal(page, baseURL!);

    // Open the form view
    await page.locator('button', { hasText: /Submit a request/i }).first().click();
    await expect(page.locator('#sub-form')).toBeVisible();

    // Project type dropdown populated from fixture
    const ptOptions = await page.locator('#form-project-type option').allTextContents();
    expect(ptOptions).toContain('New feature');

    // Locked fields rendered
    await expect(page.locator('#df-__name__')).toBeVisible();
    await expect(page.locator('#df-__customer__')).toBeVisible();
    await expect(page.locator('#df-__submitter__')).toBeVisible();

    // Email pre-filled from session and locked
    const emailInput = page.locator('#df-__email__');
    await expect(emailInput).toHaveValue('test-rep@arbiter.test');
    await expect(emailInput).toHaveAttribute('readonly', '');

    // Detail fields rendered (from fixture)
    await expect(page.locator('#df-det1')).toBeVisible(); // Description
    await expect(page.locator('#df-det2')).toBeVisible(); // Deadline

    // Criteria dropdowns rendered
    await expect(page.locator('#dd-crit1')).toBeVisible();
    await expect(page.locator('#dd-crit2')).toBeVisible();
  });

  test('Submit with missing required field shows error, no insert', async ({ page, baseURL }) => {
    let insertAttempted = false;
    await setupSignedInPortal(page, baseURL!, {
      projectsInsertHandler: () => {
        insertAttempted = true;
        return { status: 201, body: [{}] };
      },
    });

    await page.locator('button', { hasText: /Submit a request/i }).first().click();

    // Select project type but leave required locked fields empty
    await page.selectOption('#form-project-type', 'pt1');
    // Don't fill __name__, __customer__, __submitter__

    await page.locator('#btn-submit-request').click();

    // Error status visible
    const status = page.locator('#form-submit-status');
    await expect(status).toBeVisible();
    await expect(status).toHaveClass(/error/);
    await expect(status).toContainText(/Missing required field/i);

    // Insert must NOT have been attempted
    expect(insertAttempted).toBe(false);
  });

  test('Submit with unanswered criteria shows error, no insert', async ({ page, baseURL }) => {
    let insertAttempted = false;
    await setupSignedInPortal(page, baseURL!, {
      projectsInsertHandler: () => {
        insertAttempted = true;
        return { status: 201, body: [{}] };
      },
    });

    await page.locator('button', { hasText: /Submit a request/i }).first().click();

    // Fill everything EXCEPT criteria
    await page.selectOption('#form-project-type', 'pt1');
    await page.fill('#df-__name__', 'Test project');
    await page.fill('#df-__customer__', 'Acme Corp');
    await page.fill('#df-__submitter__', 'Test Rep');
    await page.fill('#df-det1', 'A description');

    await page.locator('#btn-submit-request').click();

    const status = page.locator('#form-submit-status');
    await expect(status).toBeVisible();
    await expect(status).toHaveClass(/error/);
    await expect(status).toContainText(/answer all criteria/i);

    expect(insertAttempted).toBe(false);
  });

  test('Well-formed submit sends correct payload', async ({ page, baseURL }) => {
    let capturedPayload: any = null;
    await setupSignedInPortal(page, baseURL!, {
      projectsInsertHandler: (body) => {
        capturedPayload = body;
        return {
          status: 201,
          body: [{ ...body, id: 'fake-' + Date.now(), created_at: new Date().toISOString() }],
        };
      },
    });

    await page.locator('button', { hasText: /Submit a request/i }).first().click();

    // Fill the form completely
    await page.selectOption('#form-project-type', 'pt1');
    await page.fill('#df-__name__', 'Bulk export API');
    await page.fill('#df-__customer__', 'Acme Corp');
    await page.fill('#df-__submitter__', 'Test Rep');
    await page.fill('#df-det1', 'Ability to export all customer data');
    await page.fill('#df-det2', 'Q4 2026');

    // Pick criterion options:
    //   crit1: "High (>$50k)" → index 2 → score 10 → weight 2.0
    //   crit2: "Small" → index 0 → score 10 → weight 1.0
    // Weighted score = (10*2.0 + 10*1.0) / (2.0+1.0) = 30/3 = 10.0
    // Multiply by 10, round = 100 → Pursue tier
    await page.selectOption('#dd-crit1', '2');
    await page.selectOption('#dd-crit2', '0');

    await page.locator('#btn-submit-request').click();

    // Wait for toast (signal of successful submit)
    await expect(page.locator('#toast')).toBeVisible({ timeout: 5_000 });

    // Verify the captured payload
    expect(capturedPayload).not.toBeNull();
    expect(capturedPayload.name).toBe('Bulk export API');
    expect(capturedPayload.status).toBe('Submitted');
    expect(capturedPayload.submitter_email).toBe('test-rep@arbiter.test');
    expect(capturedPayload.workspace_id).toBeTruthy();
    expect(capturedPayload.project_type).toBe('New feature');
    expect(capturedPayload.project_type_id).toBe('pt1');

    // Score/tier math
    expect(capturedPayload.score).toBe(100);
    expect(capturedPayload.tier).toBe('Pursue');

    // criteria_vals stores scores keyed by criterion id
    expect(capturedPayload.criteria_vals).toEqual({
      crit1: 10,
      crit2: 10,
    });

    // locked_vals stores the locked field values
    expect(capturedPayload.locked_vals.__name__).toBe('Bulk export API');
    expect(capturedPayload.locked_vals.__customer__).toBe('Acme Corp');
    expect(capturedPayload.locked_vals.__submitter__).toBe('Test Rep');
    expect(capturedPayload.locked_vals.__email__).toBe('test-rep@arbiter.test');

    // detail_vals
    expect(capturedPayload.detail_vals.det1).toBe('Ability to export all customer data');
    expect(capturedPayload.detail_vals.det2).toBe('Q4 2026');

    // criteria_snapshot captured for later admin review
    expect(capturedPayload.criteria_snapshot).toBeTruthy();
    expect(capturedPayload.criteria_snapshot.criteria).toBeTruthy();
    expect(capturedPayload.criteria_snapshot.weights).toBeTruthy();
    expect(capturedPayload.criteria_snapshot.tier_thresholds).toBeTruthy();

    // is_sample should be false for real submissions
    expect(capturedPayload.is_sample).toBe(false);
  });

  test('Post-submit: form resets and dashboard shows submission', async ({ page, baseURL }) => {
    // Track list GETs so we can verify the list is refreshed after insert
    let listGetCount = 0;
    let insertDone = false;
    const fakeRow = {
      id: 'fake-123',
      name: 'Submitted project',
      status: 'Submitted',
      created_at: new Date().toISOString(),
      locked_vals: { __customer__: 'Acme Corp' },
    };

    await setupSignedInPortal(page, baseURL!, {
      projectsInsertHandler: (body) => {
        insertDone = true;
        return { status: 201, body: [{ ...body, id: 'fake-123' }] };
      },
      projectsListHandler: () => {
        listGetCount++;
        // After the insert happens, return the fake row in the list
        return { status: 200, body: insertDone ? [fakeRow] : [] };
      },
    });

    // Initial state: list empty, form hidden
    await expect(page.locator('#submissions-list')).toContainText(/no submissions yet/i);

    // Open form, fill, submit
    await page.locator('button', { hasText: /Submit a request/i }).first().click();
    await page.selectOption('#form-project-type', 'pt1');
    await page.fill('#df-__name__', 'Submitted project');
    await page.fill('#df-__customer__', 'Acme Corp');
    await page.fill('#df-__submitter__', 'Test Rep');
    await page.fill('#df-det1', 'Description here');
    await page.selectOption('#dd-crit1', '1');
    await page.selectOption('#dd-crit2', '1');

    await page.locator('#btn-submit-request').click();

    // Toast appears
    await expect(page.locator('#toast')).toBeVisible({ timeout: 5_000 });

    // Dashboard view is back (not form view)
    await expect(page.locator('#sub-dashboard')).toBeVisible();
    await expect(page.locator('#sub-form')).toBeHidden();

    // Submissions list was refreshed and now shows the new row
    await expect(page.locator('#submissions-list')).toContainText('Submitted project');
    await expect(page.locator('#submissions-list')).toContainText('Acme Corp');

    // Form fields cleared for next use (check by re-opening form)
    await page.locator('button', { hasText: /Submit a request/i }).first().click();
    await expect(page.locator('#df-__name__')).toHaveValue('');
    await expect(page.locator('#df-__customer__')).toHaveValue('');
    // Email stays pre-filled from session
    await expect(page.locator('#df-__email__')).toHaveValue('test-rep@arbiter.test');
  });
});
