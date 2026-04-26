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
