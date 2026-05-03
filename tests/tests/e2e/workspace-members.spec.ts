import { test, expect } from '../helpers/fixtures';
import { openSettingsTab } from '../helpers/auth';
import { cleanTestInvitations, getPendingInvitationByEmail } from '../helpers/supabase';
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

  test('Add member: non-existent email creates a pending invitation (v1.16.0)', async ({ authedPage }) => {
    // Pre-clean any leftover invitations from previous runs.
    await cleanTestInvitations();

    // Mock the notify Edge Function so we don't fire a real email per
    // test run. The UI's success path needs a 2xx response with the
    // standard shape; everything else (DB insert, render) is the real
    // production code path.
    let notifyCalls = 0;
    let notifyBody: any = null;
    await authedPage.route('**/functions/v1/notify', async (route) => {
      notifyCalls++;
      notifyBody = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sent: 1, failed: 0, skipped: 0,
          results: [{ email: notifyBody.email || 'mocked', ok: true }],
        }),
      });
    });

    await openSettingsTab(authedPage);
    await expect.poll(async () => await authedPage.locator('#wm-list .wm-row').count())
      .toBeGreaterThan(0);

    const inviteEmail = 'invitee-' + Date.now() + '@test.invalid';
    await authedPage.locator('#wm-add-email').fill(inviteEmail);
    await authedPage.locator('#wm-add-role').selectOption('pm');
    await authedPage.getByRole('button', { name: 'Add member' }).click();

    // Wait for the toast confirming the send. The error element should
    // stay hidden — this isn't an error path anymore.
    await expect(authedPage.locator('.toast', { hasText: /invitation sent/i })).toBeVisible();
    await expect(authedPage.locator('#wm-add-error')).toBeHidden();

    // The DB should have a row in workspace_invitations.
    const inv = await getPendingInvitationByEmail(inviteEmail);
    expect(inv).not.toBeNull();
    expect(inv!.email).toBe(inviteEmail);
    expect(inv!.role).toBe('pm');
    expect(inv!.accepted_at).toBeNull();

    // The notify Edge Function should have been called exactly once,
    // with the new invitation's id.
    expect(notifyCalls).toBe(1);
    expect(notifyBody.event_type).toBe('member_invited');
    expect(notifyBody.invitation_id).toBe(inv!.id);

    // The Pending invitations section should now show this invitation.
    const pendingSection = authedPage.locator('#wm-pending');
    await expect(pendingSection).toContainText(inviteEmail);
    await expect(pendingSection).toContainText(/PM/);
    await expect(pendingSection).toContainText(/pending sign-in/i);

    // Cleanup
    await cleanTestInvitations();
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

/**
 * Pending-invite flow tests (v1.16.0).
 *
 * Background: when an admin tries to add a member by an email that
 * doesn't have an auth account yet, the UI now creates a row in
 * workspace_invitations and fires a member_invited notify event
 * instead of dead-ending. The invitation is auto-accepted by the
 * trigger from migration 011 the first time the invitee signs up.
 *
 * The notify Edge Function is mocked in these tests — we only care
 * that it's called with the right body, not that it actually sends
 * email. (Real-email coverage lives in notify-edge-function.spec.ts.)
 *
 * Out of scope: the auto-accept trigger itself. Testing it requires
 * creating a fresh auth user via the Admin API and signing them in,
 * which the current fixture set doesn't support cleanly. Manual
 * verification covers it for now.
 */
test.describe('Pending-invite flow (v1.16.0)', () => {
  test.beforeEach(async () => {
    // Each test in this block starts with no pending invitations.
    // cleanTestWorkspace from the fixture wipes projects but not
    // invitations, so we wipe invites here too.
    await cleanTestInvitations();
  });

  test('Re-invite same email shows "already sent" error pointing at Resend', async ({ authedPage }) => {
    // Mock notify so the first add succeeds without firing real email.
    await authedPage.route('**/functions/v1/notify', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sent: 1, failed: 0, skipped: 0, results: [] }),
      });
    });

    await openSettingsTab(authedPage);
    await expect.poll(async () => await authedPage.locator('#wm-list .wm-row').count())
      .toBeGreaterThan(0);

    const inviteEmail = 'reinvite-' + Date.now() + '@test.invalid';

    // First add — creates the invitation
    await authedPage.locator('#wm-add-email').fill(inviteEmail);
    await authedPage.locator('#wm-add-role').selectOption('pm');
    await authedPage.getByRole('button', { name: 'Add member' }).click();
    await expect(authedPage.locator('.toast', { hasText: /invitation sent/i })).toBeVisible();

    // Wait for the pending row to render before retrying. Otherwise the
    // second click can race the first invitation's load.
    await expect(authedPage.locator('#wm-pending')).toContainText(inviteEmail);

    // Second add of the same email — should hit the find_pending_invitation
    // RPC guard and show the "already sent" error.
    await authedPage.locator('#wm-add-email').fill(inviteEmail);
    await authedPage.getByRole('button', { name: 'Add member' }).click();

    const err = authedPage.locator('#wm-add-error');
    await expect(err).toBeVisible();
    await expect(err).toContainText(/already been sent/i);
    await expect(err).toContainText(/resend/i);

    await cleanTestInvitations();
  });

  test('Cancel pending invitation deletes the row and re-renders the list', async ({ authedPage }) => {
    await authedPage.route('**/functions/v1/notify', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sent: 1, failed: 0, skipped: 0, results: [] }),
      });
    });

    await openSettingsTab(authedPage);
    await expect.poll(async () => await authedPage.locator('#wm-list .wm-row').count())
      .toBeGreaterThan(0);

    const inviteEmail = 'cancel-' + Date.now() + '@test.invalid';

    // Send the invite
    await authedPage.locator('#wm-add-email').fill(inviteEmail);
    await authedPage.locator('#wm-add-role').selectOption('pm');
    await authedPage.getByRole('button', { name: 'Add member' }).click();
    await expect(authedPage.locator('.toast', { hasText: /invitation sent/i })).toBeVisible();
    await expect(authedPage.locator('#wm-pending')).toContainText(inviteEmail);

    // Confirm the row exists in DB
    const before = await getPendingInvitationByEmail(inviteEmail);
    expect(before).not.toBeNull();

    // Click Cancel → enters confirm state → click Confirm
    const pendingRow = authedPage.locator('#wm-pending .wm-row').filter({ hasText: inviteEmail });
    await pendingRow.getByRole('button', { name: 'Cancel' }).click();
    await pendingRow.getByRole('button', { name: 'Confirm' }).click();

    await expect(authedPage.locator('.toast', { hasText: /invitation canceled/i })).toBeVisible();

    // Row should be gone from the DOM and from the DB
    await expect(authedPage.locator('#wm-pending')).not.toContainText(inviteEmail);
    const after = await getPendingInvitationByEmail(inviteEmail);
    expect(after).toBeNull();
  });
});
