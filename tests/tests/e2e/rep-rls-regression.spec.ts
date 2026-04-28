import { test, expect } from '@playwright/test';
import { signInAsTestRep } from '../helpers/supabase';
import { createClient } from '@supabase/supabase-js';

/**
 * Rep-perspective RLS regression tests (added 2026-04-27).
 *
 * Background: The portal's first real rep sign-in revealed a silent RLS
 * cascade failure. The workspace_config SELECT policy has an EXISTS branch
 * into the `reps` table (`r.email = auth.email() AND is_active = true`).
 * That subquery is itself filtered by the `reps` table's RLS — and reps
 * had no policy allowing an authenticated user to see their own row.
 *
 * Result: workspace_config returned 0 rows for any signed-in rep, even
 * though they were properly registered. Portal form rendered empty.
 *
 * Migration 005 added a `reps_self_select` policy fixing the cascade.
 * These tests verify that fix and prevent regression.
 *
 * Approach: instead of going through the portal UI (which would require
 * wiring around the magic-link OTP flow), the tests sign in as the test
 * rep via password directly to Supabase Auth, then issue raw REST API
 * calls to verify the RLS policies behave correctly. This isolates the
 * policy behavior from any portal code.
 *
 * Note on test ordering: phase3-reps-c3 runs before us alphabetically and
 * its tests call cleanTestReps() which wipes all rows in `reps` for the
 * test workspace — including the row that links our auth user to the
 * workspace. We re-seed in beforeAll so the rep is recognized when the
 * tests run.
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY!;
const TEST_WORKSPACE_ID = process.env.TEST_WORKSPACE_ID!;
const TEST_REP_EMAIL = process.env.TEST_REP_EMAIL!;

/** REST helper: GET /rest/v1/<table> as the rep, using their JWT. */
async function repGet(token: string, path: string): Promise<{ status: number; body: any }> {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  const body = await resp.json();
  return { status: resp.status, body };
}

/**
 * Ensure the test rep has a row in `reps` for the test workspace. The
 * C.3 tests delete all reps before us, so we always re-seed.
 *
 * Uses delete-then-insert rather than upsert to avoid ON CONFLICT
 * dependencies on a specific unique-constraint definition that may
 * vary between environments.
 */
async function ensureTestRepRow(): Promise<void> {
  const adminClient = createClient(SUPABASE_URL, SUPABASE_KEY);
  await adminClient.auth.signInWithPassword({
    email: process.env.TEST_USER_EMAIL!,
    password: process.env.TEST_USER_PASSWORD!,
  });
  // Delete first (silent if no row exists)
  await adminClient.from('reps')
    .delete()
    .eq('workspace_id', TEST_WORKSPACE_ID)
    .eq('email', TEST_REP_EMAIL.toLowerCase());
  // Insert fresh
  const { error } = await adminClient.from('reps').insert({
    workspace_id: TEST_WORKSPACE_ID,
    email: TEST_REP_EMAIL.toLowerCase(),
    name: 'Test Rep (RLS regression)',
    is_active: true,
  });
  if (error) throw new Error('ensureTestRepRow failed: ' + error.message);
}

test.describe('Rep-perspective RLS', () => {
  test.beforeAll(async () => {
    await ensureTestRepRow();
  });
  test('Rep can read their own row from reps table (migration 005)', async () => {
    const { token, email } = await signInAsTestRep();
    const { status, body } = await repGet(token, `reps?email=eq.${encodeURIComponent(email)}`);
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    // Make sure the row matches us — defensive against accidental data leak
    expect(body[0].email).toBe(email);
    expect(body[0].is_active).toBe(true);
  });

  test('Rep can read workspace_config for their workspace (cascade fix)', async () => {
    const { token } = await signInAsTestRep();
    const { status, body } = await repGet(
      token,
      `workspace_config?workspace_id=eq.${TEST_WORKSPACE_ID}&select=workspace_id,detail_fields,criteria`
    );
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].workspace_id).toBe(TEST_WORKSPACE_ID);
    // Don't assert specific contents — just that we got data through RLS.
    // Earlier the bug was returning empty array, which is what this catches.
  });

  test('Rep cannot read OTHER reps in their workspace (data isolation)', async () => {
    const { token, email } = await signInAsTestRep();
    // Query reps without the email filter — should still only see our own
    // row because the policy is `email = auth.email()`.
    const { status, body } = await repGet(token, 'reps?select=email,is_active');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    // Every row returned must be the rep's own. If another rep's row leaks,
    // the policy is too permissive.
    for (const row of body) {
      expect(row.email).toBe(email);
    }
  });
});
