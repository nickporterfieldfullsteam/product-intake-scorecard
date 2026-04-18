import { test, expect } from '../helpers/fixtures';
import { countProjects, countDeletedProjects, getProjectByName, cleanTestWorkspace } from '../helpers/supabase';
import { createProject, openNewRequest } from '../helpers/scorecard';
import { signIn, openSettingsTab } from '../helpers/auth';

test.describe('Phase 2 — Supabase persistence', () => {
  test('Test B: generate sample projects persists to Supabase', async ({ authedPage }) => {
    // Pre-condition: workspace is clean (fixture ran cleanTestWorkspace)
    expect(await countProjects()).toBe(0);

    await openSettingsTab(authedPage);
    await authedPage.locator('#btn-generate-samples').click();

    // Wait for all 13 POSTs to land — we check DB directly, which is the source of truth
    await expect.poll(
      async () => await countProjects(),
      { timeout: 15_000, intervals: [500, 1000, 2000] }
    ).toBe(13);

    // Hard refresh → samples should still be there
    await authedPage.reload();
    await expect(authedPage.locator('#projects-list')).toBeVisible();
    // Wait for projects to render in the tracker
    await expect.poll(
      async () => authedPage.locator('#projects-list > *').count()
    ).toBeGreaterThan(0);

    // DB should still have 13
    expect(await countProjects()).toBe(13);
  });

  test('Test C: individual soft delete persists', async ({ authedPage }) => {
    // Seed: generate samples
    await openSettingsTab(authedPage);
    await authedPage.locator('#btn-generate-samples').click();
    await expect.poll(async () => countProjects(), { timeout: 15_000 }).toBe(13);

    // Go to tracker
    await authedPage.locator('#tab-btn-tracker').click();

    // Project rows are collapsed by default — expand the first one so its delete button is visible
    await authedPage.locator('[id^="proj-row-"]').first().click();

    // Find first delete button, click twice (first = arm, second = confirm)
    const firstDelete = authedPage.locator('[data-delete-id]').first();
    await firstDelete.click();
    await expect(firstDelete).toHaveText(/confirm/i);
    await firstDelete.click();

    // DB: 12 active, 1 soft-deleted
    await expect.poll(async () => countProjects(), { timeout: 5_000 }).toBe(12);
    expect(await countDeletedProjects()).toBe(1);

    // Hard refresh → still 12
    await authedPage.reload();
    await expect.poll(async () => countProjects()).toBe(12);
  });

  test('Test D: clear samples (the v1.9.1 fix) soft-deletes all samples in Supabase', async ({ authedPage }) => {
    // Seed
    await openSettingsTab(authedPage);
    await authedPage.locator('#btn-generate-samples').click();
    await expect.poll(async () => countProjects(), { timeout: 15_000 }).toBe(13);

    // Intercept the batch PATCH to verify it's one request, not 13
    const patchRequests: string[] = [];
    authedPage.on('response', resp => {
      if (resp.url().includes('/rest/v1/projects') && resp.request().method() === 'PATCH') {
        patchRequests.push(resp.url());
      }
    });

    // Click clear samples.
    // NOTE: generateSampleProjects() calls showTab('tracker') when it finishes,
    // so we have to navigate BACK to Settings to reach the clear-samples button.
    await openSettingsTab(authedPage);
    await authedPage.locator('#btn-clear-samples').click();

    // DB: 0 active, 13 soft-deleted
    await expect.poll(async () => countProjects(), { timeout: 10_000 }).toBe(0);
    expect(await countDeletedProjects()).toBe(13);

    // Verify it was a SINGLE batched PATCH with ?id=in.(...)
    expect(patchRequests.length).toBe(1);
    expect(patchRequests[0]).toMatch(/id=in\./);

    // Hard refresh → still 0
    await authedPage.reload();
    await expect.poll(async () => countProjects()).toBe(0);
  });

  test('Test E: save a real project from New Request persists', async ({ authedPage }) => {
    await createProject(authedPage, {
      name: 'Playwright E Test Project',
      customer: 'Test Customer LLC',
      submitter: 'Test Submitter',
      email: 'submitter@test.com',
    });

    // DB: exactly one project with that name
    const saved = await getProjectByName('Playwright E Test Project');
    expect(saved).not.toBeNull();
    expect(saved.name).toBe('Playwright E Test Project');
    expect(saved.is_sample).toBe(false);

    // Hard refresh → still there
    await authedPage.reload();
    await expect.poll(async () => (await getProjectByName('Playwright E Test Project'))?.name).toBe('Playwright E Test Project');
  });

  test('Test F: edit existing project persists', async ({ authedPage }) => {
    // Seed one project
    await createProject(authedPage, {
      name: 'Edit Test Original',
      customer: 'Edit Customer',
      submitter: 'Edit Submitter',
      email: 'edit@test.com',
    });

    const original = await getProjectByName('Edit Test Original');
    expect(original).not.toBeNull();

    // Go back to tracker, click edit on that project
    await authedPage.locator('#tab-btn-tracker').click();
    // Expand the project row so the edit button is visible (rows are collapsed by default)
    await authedPage.locator('[id^="proj-row-"]').first().click();
    await authedPage.getByRole('button', { name: /edit|re-score/i }).first().click();

    // Form should populate; change the name
    await expect(authedPage.locator('#tab-intake')).toBeVisible();
    await authedPage.fill('#df-__name__', 'Edit Test Updated');

    // Save
    const savePromise = authedPage.waitForResponse(resp =>
      resp.url().includes('/rest/v1/projects') && resp.request().method() === 'PATCH'
    );
    await authedPage.locator('#btn-save-project').click();
    await savePromise;

    // DB: old name gone, new name present
    expect(await getProjectByName('Edit Test Original')).toBeNull();
    expect(await getProjectByName('Edit Test Updated')).not.toBeNull();

    // Hard refresh
    await authedPage.reload();
    expect(await getProjectByName('Edit Test Updated')).not.toBeNull();
  });

  test('Test G: status change persists', async ({ authedPage }) => {
    await createProject(authedPage, {
      name: 'Status Test Project',
      customer: 'Status Customer',
      submitter: 'Status Submitter',
      email: 'status@test.com',
    });

    await authedPage.locator('#tab-btn-tracker').click();

    // Expand the project row so its status select is visible (rows are collapsed by default)
    await authedPage.locator('[id^="proj-row-"]').first().click();

    // Find the status select for our project and change it
    // Statuses are project-scoped selects; we change the first one
    const statusSelect = authedPage.locator('#projects-list select').first();
    await statusSelect.waitFor();

    const patchPromise = authedPage.waitForResponse(resp =>
      resp.url().includes('/rest/v1/projects') && resp.request().method() === 'PATCH'
    );
    await statusSelect.selectOption({ label: 'Under Review' });
    await patchPromise;

    // DB: status updated
    const updated = await getProjectByName('Status Test Project');
    expect(updated?.status).toBe('Under Review');

    // Hard refresh
    await authedPage.reload();
    const reloaded = await getProjectByName('Status Test Project');
    expect(reloaded?.status).toBe('Under Review');
  });

  test('Auth race regression: sign in does not double-init', async ({ page, baseURL }) => {
    // This test verifies the v1.9.1 fix — only ONE "Handling SIGNED_IN" per sign-in,
    // and only ONE "Post-auth init complete". Uses its own page (not the authedPage fixture)
    // so we can observe the sign-in from the start.

    await cleanTestWorkspace();

    const signedInHandlerLogs: string[] = [];
    const initCompleteLogs: string[] = [];
    page.on('console', msg => {
      const t = msg.text();
      if (t.includes('Handling SIGNED_IN')) signedInHandlerLogs.push(t);
      if (t.includes('Post-auth init complete')) initCompleteLogs.push(t);
    });

    const target = baseURL!;
    if (target.startsWith('file://')) await page.goto(target);
    else await page.goto(target.endsWith('/') ? target + 'index.html' : target + '/index.html');

    await page.evaluate(() => {
      Object.keys(localStorage).filter(k => k.startsWith('sb-') || k.startsWith('arbiter')).forEach(k => localStorage.removeItem(k));
    });
    await page.reload();

    await signIn(page, process.env.TEST_USER_EMAIL!, process.env.TEST_USER_PASSWORD!);

    // Give any stray async handlers a moment to fire
    await page.waitForTimeout(1000);

    expect(signedInHandlerLogs.length).toBe(1);
    expect(initCompleteLogs.length).toBe(1);
  });
});
