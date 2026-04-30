import { test, expect } from '../helpers/fixtures';
import { createClient } from '@supabase/supabase-js';

/**
 * notify Edge Function tests.
 *
 * Exercises the deploy + audit + preference-filter flow end-to-end.
 * These tests fire REAL emails through Resend — the test recipient
 * is a Gmail '+' alias on the maintainer's inbox, with a filter set
 * to auto-archive. Cost per run: ~2 sent emails.
 *
 * Test #1 (deploy health) doesn't send any emails — uses a fake
 * project_id and expects 404 immediately, before recipient lookup.
 *
 * Test #2 (audit on send) seeds a project, fires project_updated,
 * verifies the audit row landed.
 *
 * Test #3 (preference filtering) toggles the test admin's
 * notification_prefs.new_submission to false, fires new_submission,
 * verifies the audit row is 'skipped_preference' not 'sent', then
 * restores the preference. Critical to clean up — leaving the pref
 * off would silently break Test #2 of any later run.
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY!;
const TEST_USER_EMAIL = process.env.TEST_USER_EMAIL!;
const TEST_USER_PASSWORD = process.env.TEST_USER_PASSWORD!;
const TEST_WORKSPACE_ID = process.env.TEST_WORKSPACE_ID!;
const TEST_SINK_EMAIL = 'nickporterfield.fullsteam+arbiter-tests@gmail.com';

/**
 * Sign in as the test admin and return a fresh JWT.
 * We mint a new token per test rather than reusing — JWTs expire after
 * 1 hour and tests may run unattended.
 */
async function getAdminToken(): Promise<string> {
  const c = createClient(SUPABASE_URL, SUPABASE_KEY);
  const { data, error } = await c.auth.signInWithPassword({
    email: TEST_USER_EMAIL,
    password: TEST_USER_PASSWORD,
  });
  if (error || !data.session?.access_token) {
    throw new Error('Failed to sign in test admin: ' + (error?.message || 'no token'));
  }
  return data.session.access_token;
}

/** Fire the notify function and return the parsed JSON response. */
async function callNotify(token: string, body: Record<string, unknown>): Promise<{
  status: number;
  body: any;
}> {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/notify`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  let parsed: any;
  try {
    parsed = await resp.json();
  } catch {
    parsed = null;
  }
  return { status: resp.status, body: parsed };
}

/**
 * Find the most recent audit row for a given recipient in this workspace,
 * created on or after `since`. Returns null if no matching row.
 *
 * We poll because the function inserts the audit row asynchronously after
 * sending; there's a small race window between the function returning and
 * the row being visible.
 */
async function findRecentAuditRow(opts: {
  token: string;
  recipientEmail: string;
  eventType: 'new_submission' | 'project_updated';
  since: Date;
  timeoutMs?: number;
}): Promise<any | null> {
  const { token, recipientEmail, eventType, since } = opts;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const c = createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data, error } = await c
      .from('sent_notifications')
      .select('id, event_type, recipient_email, status, error, changes, created_at')
      .eq('workspace_id', TEST_WORKSPACE_ID)
      .eq('recipient_email', recipientEmail)
      .eq('event_type', eventType)
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw new Error('audit poll failed: ' + error.message);
    if (data && data.length > 0) return data[0];
    await new Promise(r => setTimeout(r, 250));
  }
  return null;
}

test.describe('notify Edge Function', () => {
  test('Deploy health: fake project_id returns 404', async () => {
    // Sanity check that the function deploys and routes correctly.
    // Fake UUID is well-formed but doesn't match any project, so the
    // function should hit the "Project not found" path early — before
    // any recipient lookup or email send.
    const token = await getAdminToken();
    const { status, body } = await callNotify(token, {
      event_type: 'project_updated',
      project_id: '00000000-0000-0000-0000-000000000000',
      changes: ['status'],
    });
    expect(status).toBe(404);
    expect(body?.error).toMatch(/not found|project/i);
  });

  test('Audit trail: project_updated send creates a sent row', async () => {
    // Seed a project with submitter_email = the test sink so we can
    // fire project_updated against it without touching real inboxes.
    const token = await getAdminToken();
    const c = createClient(SUPABASE_URL, SUPABASE_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: inserted, error: insErr } = await c
      .from('projects')
      .insert({
        workspace_id: TEST_WORKSPACE_ID,
        name: 'Notify test — audit on send',
        status: 'Submitted',
        score: 50,
        tier: 'defer',
        criteria_vals: {},
        criteria_snapshot: {},
        locked_vals: {},
        detail_vals: {},
        project_type: '',
        project_type_id: null,
        decision_notes: '',
        revisit_date: null,
        is_sample: false,
        submitter_email: TEST_SINK_EMAIL,
      })
      .select()
      .single();
    expect(insErr).toBeNull();
    expect(inserted?.id).toBeTruthy();

    const callTime = new Date();
    const { status, body } = await callNotify(token, {
      event_type: 'project_updated',
      project_id: inserted.id,
      changes: ['status'],
    });
    expect(status).toBe(200);
    expect(body?.sent).toBe(1);
    expect(body?.failed).toBe(0);

    const row = await findRecentAuditRow({
      token,
      recipientEmail: TEST_SINK_EMAIL,
      eventType: 'project_updated',
      since: callTime,
    });
    expect(row).not.toBeNull();
    expect(row.status).toBe('sent');
    expect(row.changes).toEqual(['status']);
  });

  test('Preference filter: skipping new_submission produces skipped_preference row', async () => {
    // This test toggles the test admin's notification_prefs.new_submission
    // to false, fires new_submission, verifies the audit row reflects the
    // skip, then restores the preference. The restore is in a try/finally
    // so a failed assertion doesn't leave the preference disabled and
    // break later test runs.
    const token = await getAdminToken();
    const c = createClient(SUPABASE_URL, SUPABASE_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    // Seed a project to fire new_submission against. submitter_email is
    // not used by the new_submission flow, so we leave it null to avoid
    // confusion.
    const { data: inserted, error: insErr } = await c
      .from('projects')
      .insert({
        workspace_id: TEST_WORKSPACE_ID,
        name: 'Notify test — preference filter',
        status: 'Submitted',
        score: 50,
        tier: 'defer',
        criteria_vals: {},
        criteria_snapshot: {},
        locked_vals: {},
        detail_vals: {},
        project_type: '',
        project_type_id: null,
        decision_notes: '',
        revisit_date: null,
        is_sample: false,
        submitter_email: null,
      })
      .select()
      .single();
    expect(insErr).toBeNull();

    // Flip pref off
    const { error: prefOffErr } = await c.rpc('update_my_notification_prefs', {
      p_workspace_id: TEST_WORKSPACE_ID,
      p_prefs: { new_submission: false },
    });
    expect(prefOffErr).toBeNull();

    try {
      const callTime = new Date();
      const { status, body } = await callNotify(token, {
        event_type: 'new_submission',
        project_id: inserted.id,
      });
      expect(status).toBe(200);
      expect(body?.sent).toBe(0);
      expect(body?.skipped).toBe(1);

      const row = await findRecentAuditRow({
        token,
        recipientEmail: TEST_USER_EMAIL,
        eventType: 'new_submission',
        since: callTime,
      });
      expect(row).not.toBeNull();
      expect(row.status).toBe('skipped_preference');
    } finally {
      // Always restore — even on assertion failure
      await c.rpc('update_my_notification_prefs', {
        p_workspace_id: TEST_WORKSPACE_ID,
        p_prefs: { new_submission: true },
      });
    }
  });
});
