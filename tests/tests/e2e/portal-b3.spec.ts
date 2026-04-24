import { test, expect, resolvePortalURL } from '../helpers/portal';

/**
 * Phase 3 Step B.3 — Portal rich dashboard interactions.
 *
 * Scope: list rendering with inline-expand, status chip filtering,
 * search, summary metric cards, and the edit flow (start/save).
 *
 * Like b2b, we mock workspace_config + projects endpoints so tests
 * run offline against no real DB. The fixture data is fuller here
 * because we're testing list-level behavior (filter, search, counts).
 */

const FIXTURE_CONFIG = {
  criteria: [
    {
      id: 'crit1',
      label: 'Revenue potential',
      options: [
        { label: 'Low',    score: 2 },
        { label: 'Medium', score: 6 },
        { label: 'High',   score: 10 },
      ],
    },
    {
      id: 'crit2',
      label: 'Effort',
      options: [
        { label: 'Small',  score: 10 },
        { label: 'Medium', score: 6 },
        { label: 'Large',  score: 2 },
      ],
    },
  ],
  detail_fields: [
    { id: 'det1', type: 'textarea', label: 'Description', required: false, placeholder: 'What is this?' },
  ],
  project_type_mappings: [
    { id: 'pt1', label: 'New feature', presetKey: null, activeCriteriaIds: [] },
  ],
  custom_presets: [],
  weights: { crit1: 2.0, crit2: 1.0 },
  tier_thresholds: { pursue: 75, evaluate: 55, defer: 35 },
};

/** Helper: build a projects row shape matching what REST returns. */
function makeProject(overrides: any = {}) {
  return {
    id: 'proj-' + Math.random().toString(36).slice(2, 10),
    name: 'Test project',
    status: 'Submitted',
    created_at: '2026-04-20T12:00:00Z',
    locked_vals: {
      __name__: 'Test project',
      __customer__: 'Acme Corp',
      __submitter__: 'Test Rep',
      __email__: 'test-rep@arbiter.test',
    },
    detail_vals: {},
    criteria_vals: { crit1: 10, crit2: 10 },
    criteria_snapshot: {
      criteria: FIXTURE_CONFIG.criteria,
      weights: FIXTURE_CONFIG.weights,
      tier_thresholds: FIXTURE_CONFIG.tier_thresholds,
    },
    project_type: 'New feature',
    project_type_id: 'pt1',
    decision_notes: '',
    revisit_date: null,
    ...overrides,
  };
}

/**
 * Shared setup: seed a signed-in session, mock workspace_config GET,
 * and mock projects GET to return the provided fixture rows.
 * Optionally supply a projectsPatchHandler for edit tests.
 */
async function setupSignedInDashboard(
  page: import('@playwright/test').Page,
  baseURL: string,
  fixtureRows: any[],
  options: {
    projectsPatchHandler?: (id: string, body: any) => { status: number; body: any };
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
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(fixtureRows),
      });
    } else if (method === 'PATCH') {
      // Extract project id from the URL (id=eq.<uuid>)
      const urlStr = request.url();
      const m = urlStr.match(/id=eq\.([^&]+)/);
      const projectId = m ? decodeURIComponent(m[1]) : 'unknown';
      const body = JSON.parse(request.postData() || '{}');
      const handler = options.projectsPatchHandler;
      const response = handler ? handler(projectId, body) : {
        status: 200,
        body: [{ ...body, id: projectId }],
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
  // Wait for config to load — we know it's loaded when the form's
  // project-type <select> has more than just the placeholder option.
  // This is populated synchronously after loadWorkspaceConfig resolves.
  await expect(page.locator('#form-project-type option')).toHaveCount(2, { timeout: 5_000 });
}

test.describe('Phase 3 B.3 — Portal dashboard interactions', () => {
  test('Clicking a row expands the inline detail panel; clicking again closes it', async ({ page, baseURL }) => {
    const p = makeProject({ id: 'row-a', name: 'Project A', status: 'Submitted' });
    await setupSignedInDashboard(page, baseURL!, [p]);

    const row = page.locator('#proj-row-row-a');
    const panel = page.locator('#proj-detail-row-a');

    await expect(row).toBeVisible();
    await expect(panel).not.toHaveClass(/open/);

    await row.click();
    await expect(panel).toHaveClass(/open/);
    // Panel should contain the project's details
    await expect(panel).toContainText('Acme Corp');
    await expect(panel).toContainText('New feature');

    await row.click();
    await expect(panel).not.toHaveClass(/open/);
  });

  test('Opening a second row closes the first (mutual exclusion)', async ({ page, baseURL }) => {
    const a = makeProject({ id: 'row-a', name: 'Project A', status: 'Submitted' });
    const b = makeProject({ id: 'row-b', name: 'Project B', status: 'Submitted', locked_vals: { ...a.locked_vals, __name__: 'Project B' } });
    await setupSignedInDashboard(page, baseURL!, [a, b]);

    const panelA = page.locator('#proj-detail-row-a');
    const panelB = page.locator('#proj-detail-row-b');

    await page.locator('#proj-row-row-a').click();
    await expect(panelA).toHaveClass(/open/);
    await expect(panelB).not.toHaveClass(/open/);

    await page.locator('#proj-row-row-b').click();
    await expect(panelA).not.toHaveClass(/open/);
    await expect(panelB).toHaveClass(/open/);
  });

  test('Edit button appears only for Submitted status', async ({ page, baseURL }) => {
    const submitted = makeProject({ id: 'editable', name: 'Editable one', status: 'Submitted' });
    const accepted = makeProject({ id: 'locked', name: 'Accepted one', status: 'Accepted' });
    await setupSignedInDashboard(page, baseURL!, [submitted, accepted]);

    // Expand both panels
    await page.locator('#proj-row-editable').click();
    const editableBtn = page.locator('#proj-detail-editable button', { hasText: /Edit submission/i });
    await expect(editableBtn).toBeVisible();

    await page.locator('#proj-row-locked').click();
    const lockedBtn = page.locator('#proj-detail-locked button', { hasText: /Edit submission/i });
    await expect(lockedBtn).toHaveCount(0);
  });

  test('Clicking Edit opens the form pre-filled; saving sends a PATCH with updated fields', async ({ page, baseURL }) => {
    let capturedPatch: { id: string; body: any } | null = null;
    const row = makeProject({
      id: 'edit-me',
      name: 'Original name',
      status: 'Submitted',
      locked_vals: {
        __name__: 'Original name',
        __customer__: 'Original Corp',
        __submitter__: 'Original Submitter',
        __email__: 'test-rep@arbiter.test',
      },
      detail_vals: { det1: 'Original description' },
      criteria_vals: { crit1: 6, crit2: 6 }, // both medium
    });

    await setupSignedInDashboard(page, baseURL!, [row], {
      projectsPatchHandler: (id, body) => {
        capturedPatch = { id, body };
        return { status: 200, body: [{ ...body, id }] };
      },
    });

    // Expand the row, click Edit
    await page.locator('#proj-row-edit-me').click();
    await page.locator('#proj-detail-edit-me button', { hasText: /Edit submission/i }).click();

    // Form view should be visible, pre-filled
    await expect(page.locator('#sub-form')).toBeVisible();
    await expect(page.locator('#form-title')).toContainText(/Edit submission/i);
    await expect(page.locator('#btn-submit-request')).toContainText(/Save changes/i);
    await expect(page.locator('#df-__name__')).toHaveValue('Original name');
    await expect(page.locator('#df-__customer__')).toHaveValue('Original Corp');
    await expect(page.locator('#df-__email__')).toHaveValue('test-rep@arbiter.test');

    // Change a few fields
    await page.fill('#df-__name__', 'Updated name');
    await page.fill('#df-__customer__', 'Updated Corp');
    await page.selectOption('#dd-crit1', '2'); // High — score 10
    await page.selectOption('#dd-crit2', '0'); // Small — score 10

    // Save
    await page.locator('#btn-submit-request').click();
    await expect(page.locator('#toast')).toBeVisible({ timeout: 5_000 });

    // Returned to dashboard
    await expect(page.locator('#sub-dashboard')).toBeVisible();
    await expect(page.locator('#sub-form')).toBeHidden();

    // PATCH captured
    expect(capturedPatch).not.toBeNull();
    expect(capturedPatch!.id).toBe('edit-me');
    expect(capturedPatch!.body.name).toBe('Updated name');
    expect(capturedPatch!.body.locked_vals.__name__).toBe('Updated name');
    expect(capturedPatch!.body.locked_vals.__customer__).toBe('Updated Corp');
    // Score recomputed: (10*2 + 10*1)/3 * 10 = 100, tier Pursue
    expect(capturedPatch!.body.score).toBe(100);
    expect(capturedPatch!.body.tier).toBe('Pursue');
    expect(capturedPatch!.body.criteria_vals).toEqual({ crit1: 10, crit2: 10 });
  });

  test('Search filters the list by name or customer (case-insensitive)', async ({ page, baseURL }) => {
    const rows = [
      makeProject({ id: 'p1', name: 'Bulk export API', locked_vals: { __name__: 'Bulk export API', __customer__: 'Acme Corp', __submitter__: 'x', __email__: 'x' } }),
      makeProject({ id: 'p2', name: 'CSV import',      locked_vals: { __name__: 'CSV import',      __customer__: 'Umbrella Inc', __submitter__: 'x', __email__: 'x' } }),
      makeProject({ id: 'p3', name: 'Webhook retry',   locked_vals: { __name__: 'Webhook retry',   __customer__: 'Acme Corp', __submitter__: 'x', __email__: 'x' } }),
    ];
    await setupSignedInDashboard(page, baseURL!, rows);

    // All three present initially
    await expect(page.locator('#proj-row-p1')).toBeVisible();
    await expect(page.locator('#proj-row-p2')).toBeVisible();
    await expect(page.locator('#proj-row-p3')).toBeVisible();

    // Search by name substring
    await page.fill('#project-search', 'bulk');
    await expect(page.locator('#proj-row-p1')).toBeVisible();
    await expect(page.locator('#proj-row-p2')).toHaveCount(0);
    await expect(page.locator('#proj-row-p3')).toHaveCount(0);

    // Search by customer substring, matches two
    await page.fill('#project-search', 'acme');
    await expect(page.locator('#proj-row-p1')).toBeVisible();
    await expect(page.locator('#proj-row-p2')).toHaveCount(0);
    await expect(page.locator('#proj-row-p3')).toBeVisible();

    // Clear search — all three return
    await page.fill('#project-search', '');
    await expect(page.locator('#proj-row-p1')).toBeVisible();
    await expect(page.locator('#proj-row-p2')).toBeVisible();
    await expect(page.locator('#proj-row-p3')).toBeVisible();
  });

  test('Status chip filters the list; counts reflect cache', async ({ page, baseURL }) => {
    const rows = [
      makeProject({ id: 's1', name: 'Sub one',   status: 'Submitted' }),
      makeProject({ id: 's2', name: 'Sub two',   status: 'Submitted' }),
      makeProject({ id: 'd1', name: 'Deferred 1', status: 'Deferred' }),
      makeProject({ id: 'a1', name: 'Accepted 1', status: 'Accepted' }),
    ];
    await setupSignedInDashboard(page, baseURL!, rows);

    const bar = page.locator('#status-filter-bar');
    // Chips for All + 6 statuses = 7 buttons
    await expect(bar.locator('button')).toHaveCount(7);
    // "All" chip shows total count
    await expect(bar.locator('button', { hasText: /^All/ })).toContainText('4');
    await expect(bar.locator('button', { hasText: /^Submitted/ })).toContainText('2');
    await expect(bar.locator('button', { hasText: /^Deferred/ })).toContainText('1');

    // Click "Submitted" chip
    await bar.locator('button', { hasText: /^Submitted/ }).click();
    await expect(page.locator('#proj-row-s1')).toBeVisible();
    await expect(page.locator('#proj-row-s2')).toBeVisible();
    await expect(page.locator('#proj-row-d1')).toHaveCount(0);
    await expect(page.locator('#proj-row-a1')).toHaveCount(0);

    // Click "All" chip → all rows return
    await bar.locator('button', { hasText: /^All/ }).click();
    await expect(page.locator('#proj-row-s1')).toBeVisible();
    await expect(page.locator('#proj-row-d1')).toBeVisible();
    await expect(page.locator('#proj-row-a1')).toBeVisible();
  });

  test('Summary metric cards: totals are correct; Deferred card filters the list', async ({ page, baseURL }) => {
    const rows = [
      makeProject({ id: 's1', status: 'Submitted' }),
      makeProject({ id: 's2', status: 'Submitted' }),
      makeProject({ id: 'd1', status: 'Deferred' }),
    ];
    await setupSignedInDashboard(page, baseURL!, rows);

    const metrics = page.locator('#summary-metrics');
    await expect(metrics).toBeVisible();
    // Should render three cards
    await expect(metrics.locator('.metric-card')).toHaveCount(3);
    // Total card — value 3
    await expect(metrics.locator('.metric-card').first()).toContainText('3');
    // Deferred card — last card, value 1, has warn class
    const deferredCard = metrics.locator('.metric-card').last();
    await expect(deferredCard).toContainText('1');
    await expect(deferredCard).toHaveClass(/warn/);

    // Clicking Deferred card sets status filter
    await deferredCard.click();
    await expect(page.locator('#proj-row-d1')).toBeVisible();
    await expect(page.locator('#proj-row-s1')).toHaveCount(0);

    // And the Deferred chip should now be active
    const bar = page.locator('#status-filter-bar');
    await expect(bar.locator('button.active')).toContainText(/Deferred/);
  });
});
