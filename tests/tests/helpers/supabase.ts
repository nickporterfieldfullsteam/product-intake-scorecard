import { createClient, SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

function client(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY!;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be set in .env.test');
  _client = createClient(url, key);
  return _client;
}

/**
 * Sign in as the test user and return the authed Supabase client.
 * Needed because RLS policies on projects require an authenticated user.
 */
async function authedClient(): Promise<SupabaseClient> {
  const c = client();
  const { data: { session } } = await c.auth.getSession();
  if (session) return c;
  const { error } = await c.auth.signInWithPassword({
    email: process.env.TEST_USER_EMAIL!,
    password: process.env.TEST_USER_PASSWORD!,
  });
  if (error) throw new Error('Test user sign-in failed: ' + error.message);
  return c;
}

/**
 * Sign in as the test REP (non-admin) and return the access token (JWT).
 *
 * Uses a separate Supabase client instance so the rep's session doesn't
 * clobber the admin's session — both can coexist in the same test run.
 *
 * The rep auth user must exist in Supabase (created manually in the
 * dashboard with auto-confirm) AND have a corresponding active row in
 * `reps` for TEST_WORKSPACE_ID. Without those, the test will fail to
 * sign in or RLS won't grant any access.
 *
 * Returns: { token, email } for use in raw fetch calls testing RLS.
 */
export async function signInAsTestRep(): Promise<{ token: string; email: string }> {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY!;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be set');
  const email = process.env.TEST_REP_EMAIL;
  const password = process.env.TEST_REP_PASSWORD;
  if (!email || !password) {
    throw new Error('TEST_REP_EMAIL and TEST_REP_PASSWORD must be set in .env.test (see .env.test.example)');
  }
  // Separate client instance — don't reuse the admin client because its
  // singleton session would get replaced by the rep's session.
  const repClient = createClient(url, key);
  const { data, error } = await repClient.auth.signInWithPassword({ email, password });
  if (error) throw new Error('Test rep sign-in failed: ' + error.message);
  if (!data.session?.access_token) throw new Error('Test rep sign-in returned no token');
  return { token: data.session.access_token, email };
}

/**
 * HARD delete all projects in the test workspace.
 * This runs before each test to guarantee a clean slate.
 * Uses DELETE because the test workspace is disposable — we don't need soft-delete history here.
 */
export async function cleanTestWorkspace(): Promise<void> {
  const workspaceId = process.env.TEST_WORKSPACE_ID;
  if (!workspaceId) throw new Error('TEST_WORKSPACE_ID must be set in .env.test');
  const c = await authedClient();
  const { error } = await c.from('projects').delete().eq('workspace_id', workspaceId);
  if (error) {
    // Fallback: soft delete so tests still work if router blocks DELETE
    console.warn('[test-cleanup] DELETE failed, falling back to soft delete:', error.message);
    const { error: softErr } = await c.from('projects')
      .update({ deleted_at: new Date().toISOString() })
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null);
    if (softErr) throw new Error('Soft-delete fallback also failed: ' + softErr.message);
  }
}

/** Count non-deleted projects in the test workspace. */
export async function countProjects(): Promise<number> {
  const workspaceId = process.env.TEST_WORKSPACE_ID;
  if (!workspaceId) throw new Error('TEST_WORKSPACE_ID must be set in .env.test');
  const c = await authedClient();
  const { count, error } = await c.from('projects')
    .select('*', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null);
  if (error) throw error;
  return count || 0;
}

/** Count soft-deleted projects in the test workspace. */
export async function countDeletedProjects(): Promise<number> {
  const workspaceId = process.env.TEST_WORKSPACE_ID;
  if (!workspaceId) throw new Error('TEST_WORKSPACE_ID must be set in .env.test');
  const c = await authedClient();
  const { count, error } = await c.from('projects')
    .select('*', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .not('deleted_at', 'is', null);
  if (error) throw error;
  return count || 0;
}

/** Fetch a project by name from the test workspace. */
export async function getProjectByName(name: string): Promise<any | null> {
  const workspaceId = process.env.TEST_WORKSPACE_ID;
  const c = await authedClient();
  const { data, error } = await c.from('projects')
    .select('*')
    .eq('workspace_id', workspaceId!)
    .eq('name', name)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/* ============================================================
 * PROJECT SEEDING HELPERS — for tests that need controlled
 * score / status / revisit_date combinations to verify dashboard
 * math (summary metrics, charts, etc).
 * ============================================================ */

export type SeedProjectInput = {
  name: string;
  status: string;
  score: number;
  /** ISO date string (YYYY-MM-DD) or null. Only meaningful for Deferred status. */
  revisitDate?: string | null;
  /** ISO datetime to override created_at. Defaults to NOW(). */
  createdAt?: string;
};

/**
 * Insert one or more projects into the test workspace with explicit
 * score/status/revisit_date values. Bypasses the UI so tests can
 * deterministically set up scenarios for math verification.
 *
 * Required fields (name, status, score) are explicit. Other columns
 * (criteria_vals, locked_vals, etc.) are filled with empty defaults
 * so DB constraints are satisfied. Tier is derived from score using
 * the workspace's thresholds (best-effort — defaults to 'pursue').
 */
export async function seedProjects(projects: SeedProjectInput[]): Promise<any[]> {
  const workspaceId = process.env.TEST_WORKSPACE_ID;
  if (!workspaceId) throw new Error('TEST_WORKSPACE_ID must be set in .env.test');
  if (!projects.length) return [];
  const c = await authedClient();
  const rows = projects.map(p => ({
    workspace_id: workspaceId,
    name: p.name,
    status: p.status,
    score: p.score,
    tier: p.score >= 75 ? 'pursue' : p.score >= 55 ? 'evaluate' : p.score >= 35 ? 'defer' : 'pass',
    criteria_vals: {},
    criteria_snapshot: {},
    locked_vals: {},
    detail_vals: {},
    project_type: '',
    project_type_id: null,
    decision_notes: '',
    revisit_date: p.revisitDate || null,
    is_sample: false,
    submitter_email: null,
    ...(p.createdAt ? { created_at: p.createdAt } : {}),
  }));
  const { data, error } = await c.from('projects').insert(rows).select();
  if (error) throw new Error('seedProjects failed: ' + error.message);
  return data || [];
}

/* ============================================================
 * REPS HELPERS — added in C.3 to support Reps-tab tests.
 * ============================================================ */

export type SeedRepInput = {
  email: string;
  name: string;
  isActive?: boolean;
};

/**
 * Hard-delete all reps in the test workspace. This is destructive but
 * the test workspace is disposable. Note: there's a baseline of 3 reps
 * (Sub1/Sub2/Sub3) seeded by migration 003's backfill — tests that need
 * a clean slate should call this first, then re-seed only the reps they
 * actually need.
 */
export async function cleanTestReps(): Promise<void> {
  const workspaceId = process.env.TEST_WORKSPACE_ID;
  if (!workspaceId) throw new Error('TEST_WORKSPACE_ID must be set in .env.test');
  const c = await authedClient();
  const { error } = await c.from('reps').delete().eq('workspace_id', workspaceId);
  if (error) throw new Error('cleanTestReps failed: ' + error.message);
}

/**
 * Insert one or more reps into the test workspace. is_active defaults to
 * true. Returns the inserted rows so tests can grab IDs if they need them.
 */
export async function seedTestReps(reps: SeedRepInput[]): Promise<any[]> {
  const workspaceId = process.env.TEST_WORKSPACE_ID;
  if (!workspaceId) throw new Error('TEST_WORKSPACE_ID must be set in .env.test');
  if (!reps.length) return [];
  const c = await authedClient();
  const rows = reps.map(r => ({
    workspace_id: workspaceId,
    email: r.email.toLowerCase(),
    name: r.name,
    is_active: r.isActive !== false,
  }));
  const { data, error } = await c.from('reps').insert(rows).select();
  if (error) throw new Error('seedTestReps failed: ' + error.message);
  return data || [];
}

/** Count reps in the test workspace. */
export async function countReps(): Promise<number> {
  const workspaceId = process.env.TEST_WORKSPACE_ID;
  if (!workspaceId) throw new Error('TEST_WORKSPACE_ID must be set in .env.test');
  const c = await authedClient();
  const { count, error } = await c.from('reps')
    .select('*', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId);
  if (error) throw error;
  return count || 0;
}

/** Fetch a rep by email from the test workspace. */
export async function getRepByEmail(email: string): Promise<any | null> {
  const workspaceId = process.env.TEST_WORKSPACE_ID;
  const c = await authedClient();
  const { data, error } = await c.from('reps')
    .select('*')
    .eq('workspace_id', workspaceId!)
    .eq('email', email.toLowerCase())
    .maybeSingle();
  if (error) throw error;
  return data;
}
