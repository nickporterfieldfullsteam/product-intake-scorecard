import { test, expect } from '../helpers/fixtures';
import {
  cleanTestReps,
  seedTestReps,
  countReps,
  getRepByEmail,
  cleanTestWorkspace,
} from '../helpers/supabase';
import { openRepsTab, openSettingsTab, reloadAndWaitForInit } from '../helpers/auth';
import { createProject } from '../helpers/scorecard';

/**
 * Phase 3 Step C.3 — Reps tab.
 *
 * Strategy: real Supabase. Each test starts with cleanTestReps + seed
 * only what it needs. reloadAndWaitForInit() after seeding guarantees
 * the full auth → init → showTab('tracker') cycle completes before
 * any tab navigation.
 */

test.describe('Phase 3 C.3 — Reps tab', () => {
  test.beforeEach(async ({ authedPage }) => {
    await cleanTestReps();
  });

  test('1. Reps tab renders cards from loaded reps', async ({ authedPage }) => {
    await seedTestReps([
      { email: 'alice@test.com', name: 'Alice Active' },
      { email: 'bob@test.com',   name: 'Bob Active' },
      { email: 'carol@test.com', name: 'Carol Inactive', isActive: false },
    ]);
    await reloadAndWaitForInit(authedPage);
    await openRepsTab(authedPage, 3);

    const cards = authedPage.locator('#submitters-content .submitter-card');
    await expect(cards).toHaveCount(3);
    await expect(authedPage.locator('#submitters-content')).toContainText('Alice Active');
    await expect(authedPage.locator('#submitters-content')).toContainText('Bob Active');
    await expect(authedPage.locator('#submitters-content')).toContainText('Carol Inactive');
  });

  test('2. Filter chips correctly filter by group', async ({ authedPage }) => {
    await seedTestReps([
      { email: 'a1@test.com', name: 'Active One' },
      { email: 'a2@test.com', name: 'Active Two' },
      { email: 'i1@test.com', name: 'Inactive One', isActive: false },
    ]);
    await reloadAndWaitForInit(authedPage);
    await openRepsTab(authedPage, 3);

    const cards = authedPage.locator('#submitters-content .submitter-card');
    const bar = authedPage.locator('.submitter-sort-bar');

    await expect(cards).toHaveCount(3, { timeout: 10_000 });
    await expect(bar.getByRole('button', { name: /^All\s*3/ })).toBeVisible();

    await bar.getByRole('button', { name: /^Active\s*2/ }).click();
    await expect(cards).toHaveCount(2);
    await expect(authedPage.locator('#submitters-content')).toContainText('Active One');
    await expect(authedPage.locator('#submitters-content')).not.toContainText('Inactive One');

    await bar.getByRole('button', { name: /^Inactive\s*1/ }).click({ timeout: 10_000 });
    await expect(cards).toHaveCount(1);
    await expect(authedPage.locator('#submitters-content')).toContainText('Inactive One');

    await bar.getByRole('button', { name: /^All\s*3/ }).click();
    await expect(cards).toHaveCount(3);
  });

  test('3. Unregistered submitter is classified separately from registered reps', async ({ authedPage }) => {
    await seedTestReps([
      { email: 'registered@test.com', name: 'Registered Rep' },
    ]);
    await cleanTestWorkspace();
    await reloadAndWaitForInit(authedPage);
    await createProject(authedPage, {
      name: 'Project from orphan',
      customer: 'Orphan Co',
      submitter: 'Orphan Submitter',
      email: 'orphan@test.com',
    });

    await openRepsTab(authedPage, 1);

    const cards = authedPage.locator('#submitters-content .submitter-card');
    await expect(cards).toHaveCount(2);

    const bar = authedPage.locator('.submitter-sort-bar');
    await expect(bar.getByRole('button', { name: /^Unregistered\s*1/ })).toBeVisible();

    await bar.getByRole('button', { name: /^Unregistered\s*1/ }).click();
    await expect(cards).toHaveCount(1);
    await expect(authedPage.locator('#submitters-content')).toContainText('orphan@test.com');
    await expect(authedPage.locator('.submitter-card.unregistered')).toHaveCount(1);
  });

  test('4. Add Rep modal: fill, submit, INSERT lands, list refreshes', async ({ authedPage }) => {
    await reloadAndWaitForInit(authedPage);
    await openRepsTab(authedPage, 0);

    await authedPage.locator('.add-rep-btn').click();
    await expect(authedPage.locator('#add-rep-name')).toBeVisible();

    await authedPage.fill('#add-rep-name', 'Test New Rep');
    await authedPage.fill('#add-rep-email', 'new-rep@test.com');
    await authedPage.locator('.modal-overlay').getByRole('button', { name: /add rep/i }).click();

    await expect(authedPage.locator('#toast')).toBeVisible({ timeout: 5_000 });
    await expect(authedPage.locator('.modal-overlay')).toHaveCount(0);

    await expect(authedPage.locator('#submitters-content')).toContainText('Test New Rep', { timeout: 10_000 });
    await expect(authedPage.locator('.submitter-card .rep-badge.active')).toHaveCount(1);

    const rep = await getRepByEmail('new-rep@test.com');
    expect(rep).not.toBeNull();
    expect(rep.name).toBe('Test New Rep');
    expect(rep.is_active).toBe(true);
  });

  test('5. Three-dot menu shows context-appropriate items per group', async ({ authedPage }) => {
    await seedTestReps([
      { email: 'active@test.com', name: 'Alpha Rep' },
      { email: 'inactive@test.com', name: 'Beta Rep', isActive: false },
    ]);
    await reloadAndWaitForInit(authedPage);
    await openRepsTab(authedPage, 2);

    const cards = authedPage.locator('#submitters-content .submitter-card');
    await expect(cards).toHaveCount(2, { timeout: 10_000 });

    const activeCard = authedPage.locator('.submitter-card', { hasText: 'Alpha Rep' });
    await expect(activeCard).toBeVisible();
    await activeCard.locator('.rep-menu-btn').click({ force: true });
    await expect(activeCard.locator('.rep-menu-popover')).toBeVisible();
    await expect(activeCard.locator('.rep-menu-popover')).toContainText('Copy portal link');
    await expect(activeCard.locator('.rep-menu-popover')).toContainText('Deactivate rep');
    await expect(activeCard.locator('.rep-menu-popover')).not.toContainText('Reactivate');
    await authedPage.locator('body').click({ position: { x: 5, y: 5 } });
    await expect(activeCard.locator('.rep-menu-popover')).toHaveCount(0);

    const inactiveCard = authedPage.locator('.submitter-card', { hasText: 'Beta Rep' });
    await expect(inactiveCard).toBeVisible();
    await inactiveCard.locator('.rep-menu-btn').click({ force: true });
    await expect(inactiveCard.locator('.rep-menu-popover')).toContainText('Reactivate rep');
    await expect(inactiveCard.locator('.rep-menu-popover')).not.toContainText('Deactivate');
  });

  test('6. Deactivate flow: PATCH lands and visual updates', async ({ authedPage }) => {
    await seedTestReps([
      { email: 'deact@test.com', name: 'Deactivate Me' },
    ]);
    await reloadAndWaitForInit(authedPage);
    await openRepsTab(authedPage, 1);

    const cards = authedPage.locator('#submitters-content .submitter-card');
    await expect(cards).toHaveCount(1, { timeout: 10_000 });

    const card = authedPage.locator('.submitter-card', { hasText: 'Deactivate Me' });
    await expect(card).toHaveClass(/submitter-card/);
    await expect(card).not.toHaveClass(/inactive/);

    await card.locator('.rep-menu-btn').click({ force: true });
    await expect(card.locator('.rep-menu-popover')).toBeVisible({ timeout: 5_000 });
    await card.locator('.rep-menu-popover button', { hasText: /Deactivate rep/i }).click({ force: true });
    await expect(authedPage.locator('#toast')).toBeVisible({ timeout: 5_000 });

    const newCard = authedPage.locator('.submitter-card', { hasText: 'Deactivate Me' });
    await expect(newCard).toHaveClass(/inactive/, { timeout: 5_000 });
    await expect(newCard.locator('.rep-badge')).toHaveText(/inactive/i);

    const rep = await getRepByEmail('deact@test.com');
    expect(rep.is_active).toBe(false);
  });

  test('7. Copy portal link writes a properly-formatted URL to clipboard', async ({ authedPage, browserName }) => {
    await authedPage.context().grantPermissions(['clipboard-read', 'clipboard-write']);

    await seedTestReps([
      { email: 'clip@test.com', name: 'Clip Test' },
    ]);
    await reloadAndWaitForInit(authedPage);
    await openRepsTab(authedPage, 1);

    const cards = authedPage.locator('#submitters-content .submitter-card');
    await expect(cards).toHaveCount(1, { timeout: 10_000 });

    const card = authedPage.locator('.submitter-card', { hasText: 'Clip Test' });
    await expect(card).toBeVisible();
    await card.locator('.rep-menu-btn').click({ force: true });
    await expect(card.locator('.rep-menu-popover')).toBeVisible({ timeout: 5_000 });
    await card.locator('.rep-menu-popover button', { hasText: /Copy portal link/i }).click({ force: true });
    await expect(authedPage.locator('#toast')).toBeVisible({ timeout: 5_000 });

    const clipboard = await authedPage.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toMatch(/^https:\/\/.+\/portal\/\?r=/);
    const m = clipboard.match(/\?r=([^&]+)/);
    expect(m).not.toBeNull();
    const decoded = JSON.parse(atob(decodeURIComponent(m![1])));
    expect(decoded.email).toBe('clip@test.com');
    expect(decoded.name).toBe('Clip Test');
  });

  test('8. Invite-as-rep prompts for confirmation, then INSERTs', async ({ authedPage }) => {
    await cleanTestWorkspace();
    await reloadAndWaitForInit(authedPage);
    await createProject(authedPage, {
      name: 'Project from invitee',
      customer: 'Invitee Corp',
      submitter: 'Invite Candidate',
      email: 'invitee@test.com',
    });

    await openRepsTab(authedPage, 0);

    const bar = authedPage.locator('.submitter-sort-bar');
    await bar.getByRole('button', { name: /^Unregistered/ }).click();

    const consoleErrors: string[] = [];
    authedPage.on('console', msg => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        consoleErrors.push(`[${msg.type()}] ${msg.text()}`);
      }
    });

    let capturedDialogMessage = '';
    authedPage.once('dialog', async dialog => {
      capturedDialogMessage = dialog.message();
      await dialog.accept();
    });

    const card = authedPage.locator('.submitter-card.unregistered');
    await card.locator('.rep-menu-btn').click();
    await card.locator('.rep-menu-popover button', { hasText: /Register as active rep/i }).click();

    await expect(authedPage.locator('#toast')).toContainText(/rep registered/i, { timeout: 5_000 });
    const toastText = await authedPage.locator('#toast').textContent();
    expect(capturedDialogMessage).toContain('invitee@test.com');
    const rep = await getRepByEmail('invitee@test.com');
    if (!rep) {
      throw new Error(
        `Expected rep to be inserted but DB lookup returned null.\n` +
        `Toast text: ${JSON.stringify(toastText)}\n` +
        `Captured dialog message: ${JSON.stringify(capturedDialogMessage)}\n` +
        `Console errors/warnings:\n${consoleErrors.join('\n') || '(none)'}`
      );
    }
    expect(rep.is_active).toBe(true);
    expect(rep.name).toBe('Invite Candidate');
  });

  test('9. Click-outside dismisses the three-dot menu', async ({ authedPage }) => {
    await seedTestReps([
      { email: 'menu-dismiss@test.com', name: 'Menu Dismiss' },
    ]);
    await reloadAndWaitForInit(authedPage);
    await openRepsTab(authedPage, 1);

    const card = authedPage.locator('.submitter-card', { hasText: 'Menu Dismiss' });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.locator('.rep-menu-btn').click();
    await expect(card.locator('.rep-menu-popover')).toBeVisible();

    await authedPage.locator('body').click({ position: { x: 5, y: 5 } });
    await expect(card.locator('.rep-menu-popover')).toHaveCount(0);
  });

  test('10. Settings tab no longer has the legacy Rep Links section', async ({ authedPage }) => {
    await openSettingsTab(authedPage);
    await expect(authedPage.locator('#tab-settings')).not.toContainText('Rep links');
    await expect(authedPage.locator('#rep-link-name')).toHaveCount(0);
    await expect(authedPage.locator('#rep-link-email')).toHaveCount(0);
    await expect(authedPage.locator('#rep-links-list')).toHaveCount(0);
  });
});
