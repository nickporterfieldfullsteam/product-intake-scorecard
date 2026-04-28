import { test, expect } from '../helpers/fixtures';
import { openSettingsTab } from '../helpers/auth';
import { createClient } from '@supabase/supabase-js';

/**
 * Workspace member management tests (v1.13.0).
 *
 * Background: the Settings tab has a "Workspace members" section that
 * lets admins manage the member list. Backend is migration 006 (initial
 * policies + RPCs) plus migration 007 (recursion fix using SECURITY
 * DEFINER helpers).
 *
 * Coverage scope:
 *   - RLS regression: admin can SELECT their own workspace_members row
 *     (catches migration 007's recursion bug if it ever regresses)
 *   - UI: self row renders with disabled controls
 *   - UI: add-member error states (malformed, no-account, already-member)
 *
 * Out of scope: happy-path add/update/delete flows. Those would require
 * a second auth user, and the destructive operations (delete, demote)
 * would lock the test admin out of the workspace if they regressed.
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY!;
const TEST_USER_EMAIL = process.env.TEST_USER_EMAIL!;
const TEST_USER_PASSWORD = process.env.TEST_USER_PASSWORD!;
const TEST_WORKSPACE_ID = process.env.TEST_WORKSPACE_ID!;

test.describe('Workspace member management (v1.13.0)', () => {
  test('RLS: admin can read own workspace_members row (migration 007)', async () => {
    // Direct REST call rather than going through the UI — isolates the
    // RLS check from any rendering or load-flow concerns. If the
    // recursion bug ever regresses, this test fails immediately.
    const c = createClient(SUPABASE_URL, SUPABASE_KEY);
    const { error: signInErr } = await c.auth.signInWithPassword({
      email: TEST_USER_EMAIL,
      password: TEST_USER_PASSWORD,
    });
    expect(signInErr).toBeNull();

    const { data, error } = await c.from('workspace_members')
      .select('id, user_id, role, workspace_id')
      .eq('workspace_id', TEST_WORKSPACE_ID);

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.length).toBeGreaterThan(0);

    // The admin's own row should be present
    const session = await c.auth.getSession();
    const myUserId = session.data.session?.user?.id;
    expect(myUserId).toBeTruthy();
    expect(data!.some(row => row.user_id === myUserId)).toBe(true);
  });

  test('Settings tab renders self row with disabled controls', async ({ authedPage }) => {
    await openSettingsTab(authedPage);

    // Wait for the workspace members list to populate. Initially shows
    // "Loading…" then resolves to row(s).
    const wmList = authedPage.locator('#wm-list');
    await expect(wmList).toBeVisible();

    // Wait until at least one .wm-row is present (loadWorkspaceMembers
    // runs async after openSettingsTab resolves).
    await expect.poll(
      async () => await wmList.locator('.wm-row').count(),
      { timeout: 5000 }
    ).toBeGreaterThan(0);

    // The self row is the one with "(you)" inline label
    const selfRow = wmList.locator('.wm-row').filter({ hasText: '(you)' });
    await expect(selfRow).toHaveCount(1);

    // Role select on the self row should be disabled
    const selfRoleSelect = selfRow.locator('select');
    await expect(selfRoleSelect).toBeDisabled();

    // Remove button on the self row should be disabled
    const selfRemoveBtn = selfRow.locator('button', { hasText: 'Remove' });
    await expect(selfRemoveBtn).toBeDisabled();
  });

  test('Add member: malformed email shows validation error, no network call', async ({ authedPage }) => {
    await openSettingsTab(authedPage);
    await authedPage.locator('#wm-list').waitFor();
    // Let the initial member list load before we proceed
    await expect.poll(async () => await authedPage.locator('#wm-list .wm-row').count())
      .toBeGreaterThan(0);

    // Watch for any RPC/REST request — there should be none
    let networkCallFired = false;
    authedPage.on('request', req => {
      if (req.url().includes('/rest/v1/rpc/find_user_id_by_email')
          || req.url().includes('/rest/v1/workspace_members')) {
        // Allow the initial GET that populated the list, but no POSTs/RPCs
        if (req.method() !== 'GET') networkCallFired = true;
      }
    });

    await authedPage.locator('#wm-add-email').fill('not-an-email');
    await authedPage.locator('#wm-add-role').selectOption('pm');
    await authedPage.getByRole('button', { name: 'Add member' }).click();

    const err = authedPage.locator('#wm-add-error');
    await expect(err).toBeVisible();
    await expect(err).toContainText(/valid email/i);
    expect(networkCallFired).toBe(false);
  });

  test('Add member: non-existent email shows "no account exists" error', async ({ authedPage }) => {
    await openSettingsTab(authedPage);
    await expect.poll(async () => await authedPage.locator('#wm-list .wm-row').count())
      .toBeGreaterThan(0);

    // Use a clearly-fake email that won't exist in auth.users
    await authedPage.locator('#wm-add-email').fill('definitely-not-a-real-user-12345@test.invalid');
    await authedPage.locator('#wm-add-role').selectOption('pm');
    await authedPage.getByRole('button', { name: 'Add member' }).click();

    const err = authedPage.locator('#wm-add-error');
    await expect(err).toBeVisible();
    await expect(err).toContainText(/no account exists/i);
  });

  test('Add member: existing member email shows "already a member" error', async ({ authedPage }) => {
    await openSettingsTab(authedPage);
    await expect.poll(async () => await authedPage.locator('#wm-list .wm-row').count())
      .toBeGreaterThan(0);

    // Try to add the test admin themselves — they're already a member
    await authedPage.locator('#wm-add-email').fill(TEST_USER_EMAIL);
    await authedPage.locator('#wm-add-role').selectOption('pm');
    await authedPage.getByRole('button', { name: 'Add member' }).click();

    const err = authedPage.locator('#wm-add-error');
    await expect(err).toBeVisible();
    await expect(err).toContainText(/already a member/i);
  });
});
