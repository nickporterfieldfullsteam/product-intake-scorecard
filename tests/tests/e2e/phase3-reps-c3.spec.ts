import { test, expect } from '../helpers/fixtures';
import {
  cleanTestReps,
  seedTestReps,
  countReps,
  getRepByEmail,
  cleanTestWorkspace,
} from '../helpers/supabase';
import { openRepsTab, openSettingsTab } from '../helpers/auth';
import { createProject } from '../helpers/scorecard';

/**
 * Phase 3 Step C.3 — Reps tab.
 *
 * Tests both C.3.a (display, group classification, filter chips) and
 * C.3.b (Add Rep modal, three-dot menu actions, copy portal link,
 * invite-as-rep with confirmation, Settings legacy cleanup).
 *
 * Strategy: real Supabase (matches phase2.spec.ts pattern). Each test
 * starts with cleanTestReps + seed only what it needs. Reload after
 * seeding so the main app's loadReps() picks up the new state.
 *
 * Note: the test workspace baseline has 3 reps (Sub1/Sub2/Sub3) from
 * migration 003's backfill. cleanTestReps removes those for tests that
 * need a precise count.
 */

test.describe('Phase 3 C.3 — Reps tab', () => {
  test.beforeEach(async ({ authedPage }) => {
    // authedPage fixture already cleaned projects + signed in.
    // Wipe reps too so each test starts from a known empty state.
    await cleanTestReps();
  });

  test('1. Reps tab renders cards from loaded reps', async ({ authedPage }) => {
    await seedTestReps([
      { email: 'alice@test.com', name: 'Alice Active' },
      { email: 'bob@test.com',   name: 'Bob Active' },
      { email: 'carol@test.com', name: 'Carol Inactive', isActive: false },
    ]);
    await authedPage.reload();
    await openRepsTab(authedPage, 3);

    // Three cards should render (one per rep)
    const cards = authedPage.locator('#submitters-content .submitter-card');
    await expect(cards).toHaveCount(3);
    // Verify names appear
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
    await authedPage.reload();
    await openRepsTab(authedPage, 3);

    const cards = authedPage.locator('#submitters-content .submitter-card');
    const bar = authedPage.locator('.submitter-sort-bar');

    // Wait for cards to render before interacting with filter chips
    await expect(cards).toHaveCount(3, { timeout: 10_000 });

    // All chip shows count of 3
    await expect(bar.getByRole('button', { name: /^All\s*3/ })).toBeVisible();

    // Click Active chip → 2 cards
    await bar.getByRole('button', { name: /^Active\s*2/ }).click();
    await expect(cards).toHaveCount(2);
    await expect(authedPage.locator('#submitters-content')).toContainText('Active One');
    await expect(authedPage.locator('#submitters-content')).not.toContainText('Inactive One');

    // Click Inactive chip → 1 card
    await bar.getByRole('button', { name: /^Inactive\s*1/ }).click({ timeout: 10_000 });
    await expect(cards).toHaveCount(1);
    await expect(authedPage.locator('#submitters-content')).toContainText('Inactive One');

    // Back to All
    await bar.getByRole('button', { name: /^All\s*3/ }).click();
    await expect(cards).toHaveCount(3);
  });

  test('3. Unregistered submitter is classified separately from registered reps', async ({ authedPage }) => {
    // Seed: 1 registered rep
    await seedTestReps([
      { email: 'registered@test.com', name: 'Registered Rep' },
    ]);
    // Plus 1 historical project from a submitter who's NOT in the reps table
    await cleanTestWorkspace();
    await authedPage.reload();
    await createProject(authedPage, {
      name: 'Project from orphan',
      customer: 'Orphan Co',
      submitter: 'Orphan Submitter',
      email: 'orphan@test.com',
    });

    await openRepsTab(authedPage, 1);

    // Should have 2 cards total: registered + unregistered
    const cards = authedPage.locator('#submitters-content .submitter-card');
    await expect(cards).toHaveCount(2);

    // Unregistered chip should show count of 1
    const bar = authedPage.locator('.submitter-sort-bar');
    await expect(bar.getByRole('button', { name: /^Unregistered\s*1/ })).toBeVisible();

    // Click Unregistered chip → only the orphan card
    await bar.getByRole('button', { name: /^Unregistered\s*1/ }).click();
    await expect(cards).toHaveCount(1);
    await expect(authedPage.locator('#submitters-content')).toContainText('orphan@test.com');
    // Orphan card should have the unregistered class
    await expect(authedPage.locator('.submitter-card.unregistered')).toHaveCount(1);
  });

  test('4. Add Rep modal: fill, submit, INSERT lands, list refreshes', async ({ authedPage }) => {
    await authedPage.reload();
    await openRepsTab(authedPage, 0);

    // Click + Add rep button
    await authedPage.locator('.add-rep-btn').click();
    // Modal opens
    await expect(authedPage.locator('#add-rep-name')).toBeVisible();

    // Fill and submit
    await authedPage.fill('#add-rep-name', 'Test New Rep');
    await authedPage.fill('#add-rep-email', 'new-rep@test.com');
    await authedPage.locator('.modal-overlay').getByRole('button', { name: /add rep/i }).click();

    // Toast confirms; modal closes
    await expect(authedPage.locator('#toast')).toBeVisible({ timeout: 5_000 });
    await expect(authedPage.locator('.modal-overlay')).toHaveCount(0);

    // Wait for the list to update — loadReps + renderSubmitters is async
    await expect(authedPage.locator('#submitters-content')).toContainText('Test New Rep', { timeout: 10_000 });
    await expect(authedPage.locator('.submitter-card .rep-badge.active')).toHaveCount(1);

    // DB confirms it
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
    await authedPage.reload();
    await openRepsTab(authedPage, 2);

    // Wait for cards to fully render
    const cards = authedPage.locator('#submitters-content .submitter-card');
    await expect(cards).toHaveCount(2, { timeout: 10_000 });

    // ── Active rep menu ──
    const activeCard = authedPage.locator('.submitter-card', { hasText: 'Alpha Rep' });
    await expect(activeCard).toBeVisible();
    // Wait a moment for layout to stabilize
    await authedPage.waitForTimeout(300);
    await activeCard.locator('.rep-menu-btn').click({ force: true });
    await expect(activeCard.locator('.rep-menu-popover')).toBeVisible();
    await expect(activeCard.locator('.rep-menu-popover')).toContainText('Copy portal link');
    await expect(activeCard.locator('.rep-menu-popover')).toContainText('Deactivate rep');
    await expect(activeCard.locator('.rep-menu-popover')).not.toContainText('Reactivate');
    // Close by clicking somewhere outside (page background)
    await authedPage.locator('body').click({ position: { x: 5, y: 5 } });
    await expect(activeCard.locator('.rep-menu-popover')).toHaveCount(0);

    // ── Inactive rep menu ──
    // Note: registered reps (active OR inactive) both get "Copy portal link"
    // — useful for sharing the invite link when re-engaging an inactive rep.
    // Only the toggle action differs by group.
    const inactiveCard = authedPage.locator('.submitter-card', { hasText: 'Beta Rep' });
    await expect(inactiveCard).toBeVisible();
    await authedPage.waitForTimeout(300);
    await inactiveCard.locator('.rep-menu-btn').click({ force: true });
    await expect(inactiveCard.locator('.rep-menu-popover')).toContainText('Reactivate rep');
    await expect(inactiveCard.locator('.rep-menu-popover')).not.toContainText('Deactivate');
  });

  test('6. Deactivate flow: PATCH lands and visual updates', async ({ authedPage }) => {
    await seedTestReps([
      { email: 'deact@test.com', name: 'Deactivate Me' },
    ]);
    await authedPage.reload();
    await openRepsTab(authedPage, 1);

    const cards = authedPage.locator('#submitters-content .submitter-card');
    await expect(cards).toHaveCount(1, { timeout: 10_000 });

    const card = authedPage.locator('.submitter-card', { hasText: 'Deactivate Me' });
    await expect(card).toHaveClass(/submitter-card/);
    await expect(card).not.toHaveClass(/inactive/);

    // Open menu, click Deactivate
    await authedPage.waitForTimeout(300);
    await card.locator('.rep-menu-btn').click({ force: true });
    await expect(card.locator('.rep-menu-popover')).toBeVisible({ timeout: 5_000 });
    await card.locator('.rep-menu-popover button', { hasText: /Deactivate rep/i }).click({ force: true });
    await expect(authedPage.locator('#toast')).toBeVisible({ timeout: 5_000 });

    // Card should now have inactive class + badge text changes
    const newCard = authedPage.locator('.submitter-card', { hasText: 'Deactivate Me' });
    await expect(newCard).toHaveClass(/inactive/, { timeout: 5_000 });
    await expect(newCard.locator('.rep-badge')).toHaveText(/inactive/i);

    // DB confirms
    const rep = await getRepByEmail('deact@test.com');
    expect(rep.is_active).toBe(false);
  });

  test('7. Copy portal link writes a properly-formatted URL to clipboard', async ({ authedPage, browserName }) => {
    // Clipboard API requires permissions in Chromium; grant them
    await authedPage.context().grantPermissions(['clipboard-read', 'clipboard-write']);

    await seedTestReps([
      { email: 'clip@test.com', name: 'Clip Test' },
    ]);
    await authedPage.reload();
    await openRepsTab(authedPage, 1);

    const cards = authedPage.locator('#submitters-content .submitter-card');
    await expect(cards).toHaveCount(1, { timeout: 10_000 });

    const card = authedPage.locator('.submitter-card', { hasText: 'Clip Test' });
    await expect(card).toBeVisible();
    await authedPage.waitForTimeout(300);
    await card.locator('.rep-menu-btn').click({ force: true });
    await expect(card.locator('.rep-menu-popover')).toBeVisible({ timeout: 5_000 });
    await card.locator('.rep-menu-popover button', { hasText: /Copy portal link/i }).click({ force: true });
    await expect(authedPage.locator('#toast')).toBeVisible({ timeout: 5_000 });

    // Read the clipboard
    const clipboard = await authedPage.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toMatch(/^https:\/\/.+\/portal\/\?r=/);
    // Decode the ?r= token and verify it contains the rep's email
    const m = clipboard.match(/\?r=([^&]+)/);
    expect(m).not.toBeNull();
    const decoded = JSON.parse(atob(decodeURIComponent(m![1])));
    expect(decoded.email).toBe('clip@test.com');
    expect(decoded.name).toBe('Clip Test');
  });

  test('8. Invite-as-rep prompts for confirmation, then INSERTs', async ({ authedPage }) => {
    // Seed: a project from a submitter NOT in reps (so they show as Unregistered)
    await cleanTestWorkspace();
    await authedPage.reload();
    await createProject(authedPage, {
      name: 'Project from invitee',
      customer: 'Invitee Corp',
      submitter: 'Invite Candidate',
      email: 'invitee@test.com',
    });
    await openRepsTab(authedPage, 0);

    // Filter to Unregistered to be sure
    const bar = authedPage.locator('.submitter-sort-bar');
    await bar.getByRole('button', { name: /^Unregistered/ }).click();

    // Capture console errors so failures from inviteAsRep are visible.
    const consoleErrors: string[] = [];
    authedPage.on('console', msg => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        consoleErrors.push(`[${msg.type()}] ${msg.text()}`);
      }
    });

    // Set up the dialog handler BEFORE clicking — Playwright's window.confirm
    // listener has to be registered before the dialog appears. Don't put
    // expect() inside the listener — if it throws, the dialog gets
    // auto-dismissed and the INSERT never runs. Capture for later assertion.
    let capturedDialogMessage = '';
    authedPage.once('dialog', async dialog => {
      capturedDialogMessage = dialog.message();
      await dialog.accept();
    });

    const card = authedPage.locator('.submitter-card.unregistered');
    await card.locator('.rep-menu-btn').click();
    await card.locator('.rep-menu-popover button', { hasText: /Register as active rep/i }).click();

    // Wait for the SPECIFIC success toast — the leftover "Project saved!"
    // toast from createProject() may still be visible, so a generic
    // toast.toBeVisible() returns immediately and we'd race ahead before
    // the INSERT round-trips.
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
    await authedPage.reload();
    await openRepsTab(authedPage, 1);

    const card = authedPage.locator('.submitter-card', { hasText: 'Menu Dismiss' });
    await card.locator('.rep-menu-btn').click();
    await expect(card.locator('.rep-menu-popover')).toBeVisible();

    // Click somewhere outside the card (top-left of the page background)
    await authedPage.locator('body').click({ position: { x: 5, y: 5 } });
    await expect(card.locator('.rep-menu-popover')).toHaveCount(0);
  });

  test('10. Settings tab no longer has the legacy Rep Links section', async ({ authedPage }) => {
    await openSettingsTab(authedPage);
    // The Settings tab should NOT contain a "Rep links" section heading anywhere
    await expect(authedPage.locator('#tab-settings')).not.toContainText('Rep links');
    // Legacy element ids should be gone
    await expect(authedPage.locator('#rep-link-name')).toHaveCount(0);
    await expect(authedPage.locator('#rep-link-email')).toHaveCount(0);
    await expect(authedPage.locator('#rep-links-list')).toHaveCount(0);
  });
});
