# Arbiter Playwright Tests

End-to-end tests for the Arbiter PM scorecard tool. Chromium only, local-only by default.

## One-time setup

### 1. Install dependencies

```bash
cd arbiter-tests
npm install
npm run install:browsers
```

### 2. Create the Supabase test user + workspace

We use a real Supabase account but a dedicated test user in its own workspace. This gives realistic integration coverage (same RLS, same network behavior) without polluting your real data.

**In the Supabase dashboard** (SQL Editor):

```sql
-- 1. Create the test user via Authentication → Users → "Add user" in the UI.
--    Use email: arbiter-test@<yourdomain>, password: something strong.
--    Note the user's UUID after creation.

-- 2. Create a dedicated test workspace row (adjust the INSERT to match your workspaces table schema):
INSERT INTO workspaces (id, name, created_by)
VALUES (gen_random_uuid(), 'Arbiter Test Workspace', '<test-user-uuid>')
RETURNING id;
-- Copy the returned UUID — this is your TEST_WORKSPACE_ID.

-- 3. Link the test user as admin of this workspace:
INSERT INTO workspace_members (workspace_id, user_id, role)
VALUES ('<test-workspace-id>', '<test-user-uuid>', 'admin');

-- 4. Seed a workspace_config row for the test workspace so the app has somewhere to load config from:
INSERT INTO workspace_config (workspace_id, criteria, weights, detail_fields, tier_thresholds, project_type_mappings, custom_presets, sales_help_topics)
VALUES ('<test-workspace-id>', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
```

### 3. Create `.env.test`

Copy the example and fill in real values:

```bash
cp .env.test.example .env.test
# Edit .env.test with your test user's email, password, and workspace ID.
```

`.env.test` is gitignored — never commit it.

## Running tests

Three targets, all configurable:

```bash
# Against local file:// (fastest, no deploy needed) — default
npm test

# Against a local HTTP server (auto-started on :8787)
npm run test:server

# Against GitHub Pages live URL
npm run test:live

# Individual suites
npm run test:smoke
npm run test:phase2
npm run test:scorecard
npm run test:tracker

# Debug/inspect modes
npm run test:ui       # Playwright UI mode
npm run test:headed   # See the browser
npm run test:debug    # Step through in the inspector

# View the last HTML report
npm run test:report

# Manually wipe the test workspace (if tests crashed and left data)
npm run cleanup
```

## Test file structure

```
tests/
├── helpers/
│   ├── auth.ts           signIn, signOut, clearAuthStorage
│   ├── supabase.ts       Direct DB access: clean, count, fetch
│   ├── scorecard.ts      New Request form filling
│   └── fixtures.ts       authedPage fixture (clean DB + sign in)
└── e2e/
    ├── smoke.spec.ts     App loads, auth works, core UI
    ├── phase2.spec.ts    Supabase persistence tests A–G
    ├── scorecard.spec.ts Form scoring, tier, save snapshot
    └── tracker.spec.ts   List, search, board view, metrics
```

## How the fixtures work

Every test that uses `authedPage`:

1. **Cleans the test workspace in Supabase** (DELETE, soft-delete fallback if blocked)
2. **Navigates to the app** (file://, http://, or https:// depending on `TEST_TARGET`)
3. **Clears browser auth storage** to guarantee a fresh session
4. **Signs in as the test user** and waits for `[Arbiter] Post-auth init complete`
5. **Yields the authed page to the test**

Tests are run serially (`workers: 1`) because they share one Supabase workspace. If you need parallelism later, create multiple test workspaces and shard tests across them.

## Why local file:// works

The app is a single-file HTML with CDN-loaded Supabase SDK — no build step, no server required. Playwright can load `file:///.../index.html` directly and Supabase still works because CORS only applies to cross-origin HTTP(S), not file protocol (for the JS-SDK's case).

The only gotcha: `baseURL` for file:// is the full path to index.html, so the fixture special-cases it.

## Notes on the router-blocks-DELETE issue

Your home router blocks HTTP DELETE. The test helper handles this gracefully:

- `cleanTestWorkspace()` tries DELETE first (fast, full cleanup)
- If DELETE fails, falls back to soft-delete (matches production behavior)
- The cleanup script does the same

This means the test suite works both from your home network and from any other network.

## Adding new tests

1. **Reusable flow?** Add to `tests/helpers/`.
2. **New feature?** New spec file in `tests/e2e/`.
3. **Use `authedPage` from `../helpers/fixtures`** — not the raw Playwright `page` — so you get auto-cleanup and auth.
4. **Assert against Supabase, not just the UI.** UI state can lie (localStorage); the DB is the source of truth.
5. **Follow the sign-in console-log pattern** for waiting on async state — relies on the `[Arbiter] ...` logs added in v1.9.1.
