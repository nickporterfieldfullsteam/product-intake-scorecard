#!/usr/bin/env node
// Manual cleanup: wipe all projects in the test workspace.
// Run: npm run cleanup

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.test' });

(async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  const email = process.env.TEST_USER_EMAIL;
  const password = process.env.TEST_USER_PASSWORD;
  const workspaceId = process.env.TEST_WORKSPACE_ID;

  if (!url || !key || !email || !password || !workspaceId) {
    console.error('Missing required env vars in .env.test');
    process.exit(1);
  }

  const sb = createClient(url, key);
  const { error: authErr } = await sb.auth.signInWithPassword({ email, password });
  if (authErr) { console.error('Auth failed:', authErr.message); process.exit(1); }

  // Try DELETE first, fall back to soft delete if blocked
  const { error: delErr, count } = await sb.from('projects')
    .delete({ count: 'exact' })
    .eq('workspace_id', workspaceId);

  if (delErr) {
    console.warn('DELETE blocked — falling back to soft delete:', delErr.message);
    const { error: softErr, count: softCount } = await sb.from('projects')
      .update({ deleted_at: new Date().toISOString() }, { count: 'exact' })
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null);
    if (softErr) { console.error('Soft delete also failed:', softErr.message); process.exit(1); }
    console.log(`Soft-deleted ${softCount || 0} projects in test workspace.`);
  } else {
    console.log(`Hard-deleted ${count || 0} projects in test workspace.`);
  }

  await sb.auth.signOut();
  process.exit(0);
})();
