import { Page, expect } from '@playwright/test';

export interface ScorecardInput {
  name: string;
  customer: string;
  submitter: string;
  email: string;
  projectTypeIndex?: number;  // 1-based index into project type dropdown (1 = first real option)
  criteriaChoiceIndex?: number;  // For each criterion, which option to pick (1-based). Defaults to 2 (middle-ish)
}

/** Open the New Request panel via the floating + button. */
export async function openNewRequest(page: Page) {
  await page.locator('#new-request-fab').click();
  await expect(page.locator('#tab-intake')).toBeVisible();
}

/** Fill the locked fields (name, customer, submitter, email). */
export async function fillLockedFields(page: Page, input: ScorecardInput) {
  await page.fill('#df-__name__', input.name);
  await page.fill('#df-__customer__', input.customer);
  await page.fill('#df-__submitter__', input.submitter);
  await page.fill('#df-__email__', input.email);
}

/**
 * Pick the first non-empty project type option.
 * projectTypeIndex=1 → first real type (skipping the placeholder).
 */
export async function pickProjectType(page: Page, index: number = 1) {
  const select = page.locator('#project-type-select');
  await select.waitFor();
  // Get all option values, skip the blank placeholder
  const optionValues = await select.locator('option').evaluateAll(opts =>
    opts.map(o => (o as HTMLOptionElement).value).filter(v => v && v !== '')
  );
  if (!optionValues.length) throw new Error('No project types available in dropdown');
  const chosen = optionValues[Math.max(0, index - 1)] || optionValues[0];
  await select.selectOption(chosen);
  // Wait for criteria to render in response
  await page.waitForFunction(() => {
    const container = document.getElementById('criteria-fields');
    return container && container.querySelectorAll('select').length > 0;
  }, { timeout: 5_000 });
}

/**
 * Pick the same option index (1-based) for every criterion dropdown.
 * Default is option 2 (first non-placeholder for most criteria).
 */
export async function answerAllCriteria(page: Page, optionIndex: number = 2) {
  const selects = page.locator('#criteria-fields select');
  const count = await selects.count();
  for (let i = 0; i < count; i++) {
    const sel = selects.nth(i);
    const values = await sel.locator('option').evaluateAll(opts =>
      opts.map(o => (o as HTMLOptionElement).value).filter(v => v !== '')
    );
    if (!values.length) continue;
    const target = values[Math.min(optionIndex - 1, values.length - 1)];
    await sel.selectOption(target);
  }
  // Let updateScore() run
  await page.waitForTimeout(250);
}

/** Full flow: open new request, fill, pick type, answer criteria, save. */
export async function createProject(page: Page, input: ScorecardInput) {
  await openNewRequest(page);
  await pickProjectType(page, input.projectTypeIndex ?? 1);
  await fillLockedFields(page, input);
  await answerAllCriteria(page, input.criteriaChoiceIndex ?? 2);

  // Click save, wait for Supabase POST to settle
  const savePromise = page.waitForResponse(resp =>
    resp.url().includes('/rest/v1/projects') &&
    (resp.request().method() === 'POST' || resp.request().method() === 'PATCH')
  );
  await page.locator('#btn-save-project').click();
  const resp = await savePromise;
  if (!resp.ok()) throw new Error(`Save project failed: ${resp.status()} ${await resp.text()}`);
  return resp;
}
