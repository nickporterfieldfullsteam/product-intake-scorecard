# Arbiter

A PM scorecard app for evaluating incoming feature/project requests on a consistent rubric.
Reps submit through a portal; admins and PMs review, score, decide, and notify back.

Live admin app: <https://nickporterfieldfullsteam.github.io/arbiter/>
Live rep portal: <https://nickporterfieldfullsteam.github.io/arbiter/portal/>

Currently: main app v1.17.0-alpha, portal v0.6.0.

---

## Recent significant changes

A short orienting note for future readers; full history in `git log`.

* **v1.17.0-alpha — Execution tracking arc.** Full end-to-end execution
  tracking: Arbiter now covers submission through delivery, replacing the
  manual Confluence board. Nav restructured: new Dashboard (PM operations
  view, default landing page) → Intake (formerly Dashboard) → Active
  Projects → Reps → Help. Migration 013 added seven `execution_*` columns
  to `projects` and seven config columns to `workspace_config`. Two
  SECURITY DEFINER RPCs (`validate_status_board_token`,
  `get_status_board_projects`) enable the shareable status board at
  `/arbiter/status/` — a standalone public page for stakeholders with no
  login, no scores, token-gated access. Active Projects config (six
  manageable lists with color palettes + status board token) lives in
  ⚙ → Active Projects config. Dashboard shows six metric cards and four
  attention widgets (needs attention, unreviewed, overdue ETAs, upcoming
  revisits). Help tab and Take a Tour (10 steps) fully updated. 91
  Playwright tests covering all new features.

* **v1.16.0 — Pending-invite flow.** An admin can now invite a member by
  email even if that person doesn't have an auth account yet. The
  invitation creates a row in `workspace_invitations` (migration 011) and
  fires a `member_invited` notify event. When the invitee signs in for the
  first time, a trigger on `auth.users` auto-converts the invitation into
  a `workspace_members` row with the saved role — no "click to accept"
  screen, the magic-link sign-in is the acceptance. The Settings tab now
  shows a "Pending invitations" section above the Add-a-member form with
  Resend and Cancel actions per row. Migration 012 widened the
  `sent_notifications.event_type` CHECK to include the new event.
* **v1.15.x — EmailJS removal arc, Help rewrite, and follow-up cleanups.**
  The exported sales form, manual decision-email modal, and all EmailJS
  scaffolding were removed (~1500 lines net). Anything that used to flow
  through EmailJS now goes through the notify Edge Function. The portal
  at `/arbiter/portal/` is the only path for reps to submit. Help section
  and Take a Tour were rewritten to match the current product; the old
  text described features that no longer exist. Two follow-up cleanups
  landed in v1.15.2 (QA checklist items for removed features) and v1.15.3
  (the orphaned `salesHelpTopics` editor). Migration 010 dropped the
  now-orphaned `workspace_config.sales_help_topics` column.
* **v1.14.x — Notifications and observability.** The notify Edge Function
  was built; transactional emails fire automatically on new submissions
  and project status changes (see [Email notifications](#email-notifications)).
  Audit trail in `sent_notifications` and per-recipient preferences in
  `workspace_members.notification_prefs` were added in 008/009.
* **v1.13.x — Workspace member management.** Admins/PMs are managed via
  the Settings tab; migrations 006/007 added the policies and SECURITY
  DEFINER helpers that the rest of the system now relies on.

---

## What this is

Arbiter exists to make "should we build this?" decisions traceable and to track
accepted projects through delivery. A rep submits a project description plus answers
to a scoring rubric (revenue potential, strategic alignment, effort, time sensitivity,
etc). The app computes a weighted score, places the request in a tier
(pursue / evaluate / defer / pass), and gives the PM a tracker to manage the pipeline.
Once accepted, projects move to the Active Projects tab where the PM tracks execution
through lifecycle stages with platform, priority, status, ETA, and owner assignments.

Three surfaces:

* **Main app** — admins and PMs. Dashboard (ops view), Intake (review queue), Active
  Projects (execution pipeline), Reps (portal management), scoring config, member
  management, the full data model.
* **Portal** — reps only. Submit a request, see your own submission history, get notified
  when status changes.
* **Status board** — stakeholders. Read-only view of active projects grouped by lifecycle
  stage. No login required, token-gated. No scores or tier data shown.

Reps never see scores or rankings — only the status decisions communicated back to them.
That's a product principle, enforced both in UI rendering and in email content.

---

## Repo layout

```
arbiter/
├── index.html              The entire admin app — single-file HTML+CSS+JS,
│                           ~7300 lines. Versioned via VERSION constant near top.
├── portal/
│   └── index.html          The entire rep portal — single-file, ~1500 lines.
├── status/
│   └── index.html          Shareable status board — standalone page, token-gated,
│                           no auth required. Shows execution data only, no scores.
├── ArbiterLogo_SVG.svg     Arbiter logo mark, used in app header, status board,
│                           and favicon.
├── db/
│   └── migrations/         SQL migrations applied to the Supabase project,
│                           numbered 001 through 013. Apply via Supabase
│                           dashboard SQL editor; no automated runner.
├── supabase/
│   ├── config.toml         CLI link config — generated by `supabase init`.
│   └── functions/
│       └── notify/         Edge Function for transactional email — handles
│           └── index.ts    new_submission, project_updated, member_invited.
├── tests/
│   └── tests/
│       ├── e2e/            Playwright tests, 91 currently.
│       └── helpers/        Auth + Supabase fixtures shared across tests.
├── .github/
│   └── workflows/
│       └── test.yml        Runs the Playwright suite on every push and PR.
└── assets/
    └── logo.png            Arbiter mark (PNG), used in email templates.
```

The single-file HTML pattern is deliberate. The app is small enough that splitting into
modules would add ceremony without buying anything. Both the main app and portal embed
their CSS and JS inline; deploy is just `git push` to GitHub Pages.

---

## Architecture

### Frontend

* **Vanilla JS** — no React, no bundler, no build step. The browser loads `index.html`
  and runs.
* **Supabase JS client** — pulled from CDN. Used for auth + most table queries. A few
  spots use raw `fetch` to PostgREST (the portal does this exclusively because it
  predates the JS client integration there).
* **Single workspace per session** — `currentWorkspaceId` is loaded once at sign-in and
  pinned. Multi-workspace is on the roadmap but not built.

### Backend (Supabase)

* **Postgres + RLS** — every table has Row-Level Security policies. Admin/PM access is
  via `workspace_members`; rep access is via `reps` (matched on `auth.email()`).
* **PostgREST** — the auto-generated REST API in front of Postgres. The browser hits
  `/rest/v1/<table>` with the user's JWT.
* **Auth (GoTrue)** — magic-link OTP for both admins and reps. Custom email templates
  live in Supabase dashboard.
* **Edge Function** — single `notify` function handling email events. Deploys via
  `supabase functions deploy`. See [Email notifications](#email-notifications).
* **Resend** — email delivery for both auth emails and notify function emails. Domain
  `mail.porterfieldtools.com` (subdomain of porterfieldtools.com) is verified with
  DKIM/SPF/DMARC. All Arbiter mail sends from `noreply@mail.porterfieldtools.com`.

### Auth model

Two distinct user types, both stored in `auth.users`:

| Role | Stored where | Sign-in method | Access |
| --- | --- | --- | --- |
| Admin / PM | `workspace_members` (linked by `user_id`) | Magic link via main app | Full workspace |
| Rep | `reps` (linked by `email`) | Magic link via portal | Submit + own history |

The two surfaces share the same Supabase auth backend, but their RLS policies route
them to entirely different data. Admins never see the portal experience; reps can
never read each other's submissions.

Pending admin/PM invites — i.e. invitations to people who don't yet have an
`auth.users` row — live in `workspace_invitations` (added in migration 011) until the
invitee signs in for the first time. A trigger on `auth.users` AFTER INSERT
auto-converts pending invitations into `workspace_members` rows by lowercased email
match. The acceptance is silent; there's no separate accept screen because the
magic-link sign-in IS the acceptance.

---

## Database schema (high-level)

| Table | What it holds |
| --- | --- |
| `workspaces` | Top-level tenant. Currently single-workspace in practice. |
| `workspace_members` | Admin/PM membership. `(workspace_id, user_id, role, notification_prefs)`. The `notification_prefs` JSONB column (added in 009) records per-member opt-outs like `{"new_submission": false}`; missing keys default to subscribed. |
| `workspace_invitations` | Pending admin/PM invites by email (added in 011). `(workspace_id, email, role, invited_by, invited_at, accepted_at)` with `UNIQUE (workspace_id, email)`. A trigger on `auth.users` auto-accepts these on sign-up by lowercased email match, inserting the corresponding `workspace_members` row and stamping `accepted_at`. |
| `workspace_config` | Per-workspace scoring rubric: criteria, options/scores, weights, tier thresholds, custom detail fields. Also holds execution tracking config: six JSONB list columns (`execution_sponsor_groups`, `execution_platforms`, `execution_priorities`, `execution_lifecycle_stages`, `execution_statuses`, `execution_people`) storing `[{label, bg, color}]` objects, plus `status_board_token` (text) for the shareable board. |
| `reps` | Authorized submitters. `(workspace_id, email, name, is_active)`. |
| `projects` | Submitted projects. Includes `criteria_vals` JSONB (id → score), `locked_vals` JSONB (the form's locked fields like `__customer__`, `__submitter__`, `__email__`), `detail_vals` JSONB (custom field values), plus columns for status, decision\_notes, revisit\_date, etc. Accepted projects also carry seven `execution_*` columns: `execution_sponsor_group`, `execution_platform`, `execution_priority`, `execution_eta` (date), `execution_lifecycle`, `execution_status`, `execution_owners` (text[]). |
| `sent_notifications` | Audit log of email notifications (added in 008). Every send attempt — successful, failed, or skipped — gets a row with workspace\_id, project\_id (nullable, ON DELETE SET NULL), event\_type (`'new_submission'` / `'project_updated'` / `'member_invited'`), recipient\_email, status (`'sent'` / `'failed'` / `'skipped_preference'` / `'skipped_self'`), error, changes, created\_at. workspace\_members can SELECT; only the Edge Function (via service-role) writes. |

Every modification we've made lives in `db/migrations/` numbered sequentially. Read
the comments at the top of each migration file — they document the bug or feature
that prompted the change.

### RLS conventions (READ THIS BEFORE TOUCHING POLICIES)

Two silent-RLS-denial bugs landed in production during development. Both manifested as
**status 200 + empty array** responses, indistinguishable from "no row exists." Both
required impersonated SQL Editor sessions to diagnose.

**The pattern that bites:** when a policy on table T includes `EXISTS (SELECT 1 FROM other_table WHERE ...)`, that subquery is itself RLS-evaluated as the same caller. If
`other_table` is also RLS-protected and the caller can't read the row that would
satisfy the EXISTS, the entire outer query silently denies.

**The recursion variant:** when a policy on T includes `EXISTS (SELECT 1 FROM T ...)`,
Postgres detects recursive policy reference and short-circuits to "no rows visible."
The whole table appears empty.

**The fix pattern:** use `SECURITY DEFINER` helper functions for the membership/role
checks. They bypass RLS for the lookup, return only a boolean about the caller's own
status, and break the recursion. Migration 007 establishes the pattern with
`is_workspace_member()` and `is_workspace_admin()`.

When writing new policies, prefer:

```
USING (public.is_workspace_member(workspace_id))
```

over:

```
USING (EXISTS (SELECT 1 FROM workspace_members WHERE ...))
```

unless you've verified the EXISTS doesn't have either failure mode.

---

## Email notifications

Three event types, all sent through the `notify` Edge Function:

* **`new_submission`** — fired by the portal after a rep submits a project. Emails
  every workspace\_member (admin and PM both) who hasn't opted out.
* **`project_updated`** — fired by the main app's `saveDraft` when status, decision
  notes, or revisit date changed. Emails the rep who originally submitted, but skips
  if the rep is the same user who made the change.
* **`member_invited`** — fired by the main app when an admin creates a
  `workspace_invitations` row. Emails the invitee with the workspace name, the
  role they're being granted, and a sign-in link. Acceptance is automatic on first
  sign-in via the trigger from migration 011.

All three are fire-and-forget at the call site — no user-visible flow blocks on email
delivery. Failures log to the function's logs (Supabase dashboard) and the client's
console; they don't fail the underlying action.

The function uses the service-role key for lookups (bypasses RLS) and the Resend API
for delivery. The email templates are inline HTML in `notify/index.ts` and use a
table-based layout for cross-client consistency.

Reps **never** see scoring information in their emails. The `project_updated`
template has no score, no tier, no scoring breakdown — only the status pill and
any decision notes. This is enforced in code, not just convention.

**Audit trail.** Every send attempt — successful, failed, or skipped via preference —
writes a row to `sent_notifications`. The Settings tab in the main app surfaces the
last 50 entries with status pills, recipient, and relative time. Failed rows expose
the error string via tooltip on the pill. Audit inserts are wrapped in try/catch so
a broken audit table never breaks the notification flow itself.

**Recipient preferences.** Each workspace member can opt out of `new_submission`
notifications via a checkbox on their own row in the Workspace Members section.
The toggle calls the SECURITY DEFINER RPC `update_my_notification_prefs` (added in
migration 009), which validates that the caller is updating their own row.
Default-true semantics: a missing or null preference key means "subscribed."
Skipped recipients still get an audit row with `status = 'skipped_preference'`.

Rep-side opt-out is intentionally not implemented — reps almost always want status
notifications, and the policy implications are different.

---

## Tests

Playwright tests in `tests/tests/e2e/`. Run with:

```
arbiter-test     # alias for: cd tests && npm test
```

Currently 91 tests, all green. They run against the **real Supabase** (the test
workspace, fixture-isolated from prod) for behavior tests, and use mocked fetch
intercepts for UI/contract tests.

GitHub Actions runs the full suite on every push to main and every pull request
(see `.github/workflows/test.yml`). A concurrency lock serializes runs to prevent
races against the shared test workspace. Failed runs upload the Playwright HTML
report as an artifact for offline inspection.

Test #2 in `notify-edge-function.spec.ts` fires a real email per run via Resend
(target: a Gmail '+' alias on the maintainer's inbox, filtered to auto-archive).
Volume stays well within the Resend free tier at any sane push frequency. Other
notify-related tests mock the Edge Function via `page.route` rather than firing
live emails, so adding more invitation/notification tests doesn't fan out the
real-email volume.

### Test fixtures

Two auth users, both confirmed:

* `arbiter-test@test.com` — admin user. Member of TEST\_WORKSPACE\_ID. Used for
  most behavioral tests via the `authedPage` fixture.
* `arbiter-test-rep@test.com` — rep user. Has a row in `reps` for TEST\_WORKSPACE\_ID
  (re-seeded before rep-RLS tests because phase3-reps-c3 wipes it).

Credentials live in `tests/.env.test` (gitignored). Template at `.env.test.example`.

### Fixture pattern

The single test workspace is shared across all tests in a run. `cleanTestWorkspace()`
wipes projects between tests; `cleanTestReps()` wipes reps when needed;
`cleanTestInvitations()` wipes pending invitations when needed. Tests must be
order-independent within a file but assume serialized execution overall (the
config is `workers: 1`).

---

## Deploy

### Frontend (main app + portal)

```
git push origin main
```

GitHub Pages serves the repo root. Push to `main`, wait ~60s, hard-refresh.

### Edge Function

```
supabase functions deploy notify
```

Requires the Supabase CLI logged in and linked. Function reads three secrets
(`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`) from the project's
secrets store; the first two are auto-injected, `RESEND_API_KEY` is set manually
via `supabase secrets set RESEND_API_KEY=...`.

### Database migrations

No automated runner. Open Supabase dashboard → SQL Editor → paste the migration
file → run. Each migration includes a `DO $$ ... RAISE EXCEPTION ...` verification
block that fails loudly if the policies/functions didn't land as expected.

Apply migrations in numerical order on a fresh deployment. Skipping migrations is
not safe — they build on each other.

**Schema-touching migrations should land before the JS that depends on them.**
v1.16.0 illustrates the pattern: migration 011 (table + trigger) and migration 012
(widen `sent_notifications.event_type` CHECK) both shipped to Supabase before the
Edge Function deploy and before the `index.html` push, so each layer found the
schema it expected. Inverting the order would have left the Edge Function's audit
inserts silently failing the CHECK constraint until 012 caught up.

### CI

GitHub Actions runs `tests/` on every push to main and on pull requests. No manual
step required — push and watch the **Actions** tab. The workflow uses a concurrency
lock so two pushes in quick succession serialize rather than race against the shared
test workspace.

Required GitHub Secrets (configured under repo Settings → Secrets and variables →
Actions): `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `TEST_WORKSPACE_ID`,
`TEST_USER_EMAIL`, `TEST_USER_PASSWORD`, `TEST_REP_EMAIL`, `TEST_REP_PASSWORD`.

---

## Operational gotchas

Things that have actually bitten in development. Knowing about them saves debugging
time.

* **`auth.users` is not queryable from the client.** Use the Auth Admin API
  (`sb.auth.admin.listUsers`) or a `SECURITY DEFINER` RPC. The supabase-js client's
  `.schema('auth').from('users')` does not work, even with service-role.
* **`criteria_vals` stores the score, not an option index.** A criterion's options
  are `[{label, score}, ...]` and `criteria_vals[crit.id]` is the score itself
  (1, 3, 5, 7, 10, etc.). Look up the option via `c.options.find(o => o.score === val)`,
  not `c.options[idx]`.
* **`locked_vals` keys are double-underscored.** `__customer__`, `__submitter__`,
  `__email__`, `__name__`. The double underscores distinguish them from custom
  detail fields, which use generated IDs.
* **The in-memory project shape doesn't carry `submitter_email` at the top level.**
  `loadProjects` doesn't copy that column; access it via `project.lockedVals.__email__`
  instead.
* **Edge Functions need explicit CORS handling.** Browsers send OPTIONS preflight
  before authenticated POSTs; the function must return 204 with `Access-Control-Allow-*`
  headers, and every actual response must include the headers too.
* **JWTs from Supabase Auth expire after 1 hour.** Long-running test sessions or
  manual curl debugging will hit `UNAUTHORIZED_ASYMMETRIC_JWT` and need to re-mint.
* **Magic-link redirect must be in the Supabase allowlist.** Project Settings → Auth →
  URL Configuration → Redirect URLs needs both the main app and portal patterns
  (`/arbiter/**`).
* **Pushing workflow files requires the `workflow` PAT scope.** GitHub blocks PATs
  without it from creating or updating files under `.github/workflows/`. Symptom:
  `remote rejected ... refusing to allow a Personal Access Token to create or update workflow X without 'workflow' scope`. Fix: regenerate the PAT with `repo` AND
  `workflow` scopes checked.
* **Removing or changing a feature? Grep tests for user-visible strings AND
  function names.** Playwright tests sometimes assert on user-visible strings
  (e.g. `toContainText('Sales form')`, `toContainText(/no account exists/i)`)
  rather than function existence. Function-name greps won't find them, and CI
  fails after push. This has bitten twice now: once during the v1.15 sales-form
  removal (`phase3-reps-c3.spec.ts` still asserted on 'Sales form'), and again
  during v1.16.0's invitation flow (`workspace-members.spec.ts` still asserted
  on 'no account exists' for non-existent emails). Pre-flight grep should always
  include the feature's user-facing strings.
* **`sent_notifications` grows forever.** No automated retention. At current volume
  this is fine but a future cron job's worth of work if it ever matters.
* **Execution fields use snake_case in memory, intake fields use camelCase.**
  `loadProjects()` maps `locked_vals` → `lockedVals`, `criteria_vals` → `criteriaVals`,
  but execution fields stay snake_case (`p.execution_sponsor_group`, not
  `p.executionSponsorGroup`). Both work but mixing conventions means you can't assume
  one pattern. The `revisitDate` property (camelCase) vs `execution_eta` (snake_case)
  on the same object is the sharpest example.
* **Owner chips use draft state.** `addExecOwnerChip` / `removeExecOwnerChip` manipulate
  a hidden input (`exec-ow-{uid}`) and rebuild only the chips DOM — they don't touch
  other form fields or save to DB. Owners are persisted alongside all other execution
  fields when the Save button is clicked. This was a bug fix: the original approach
  re-rendered the entire execution section on owner change, clearing unsaved dropdowns.
* **Removing JS that touches a JSONB column? Plan to drop the column too.** When
  `salesHelpTopics` was removed from `index.html` in v1.15.3, the
  `workspace_config.sales_help_topics` JSONB column was left in place
  temporarily — harmless (the persist payload no longer wrote to it, the load
  no longer read from it), but dead schema. Migration 010 dropped the column
  in a follow-up. The pattern: a JS-only removal leaves an orphan column that
  will confuse future readers of the schema. Pair the JS commit with a
  drop-column migration in the same arc.
* **CHECK constraints aren't ALTER'd, they're dropped and recreated.** Postgres
  has no `ALTER CONSTRAINT ... CHECK`. Migration 012 demonstrates: widen a
  whitelisted-values CHECK by `DROP CONSTRAINT IF EXISTS` followed by `ADD
  CONSTRAINT ... CHECK (...)` with the new value list. Both operations are
  metadata-only (no row scan), so this runs in milliseconds even on populated
  tables. Do this **before** the code that produces the new value lands, or
  every insert silently fails the constraint until the migration catches up.
* **Triggers on `auth.users` need superuser context to install.** Supabase's
  managed Postgres allows it, but the SQL Editor must run as the `postgres` role
  (the dashboard's default) — not as a regular role. Migration 011 installs
  one such trigger; if a future migration touches `auth.*` and you get a
  permission error, this is why.
* **Don't assume database layout — verify it.** Multiple migrations now exist
  because verifying schema before writing the migration caught real divergence
  from assumptions: migration 011's role CHECK had to mirror an existing
  `('admin', 'pm', 'viewer')` set rather than the assumed `('admin', 'pm')`,
  and migration 012 only existed because querying `sent_notifications`'s
  CHECK constraints surfaced the whitelist of allowed `event_type` values
  before the Edge Function update could fail silently. The cost of a verification
  query is a single SQL Editor paste; the cost of a wrong assumption is a
  silently-failing migration in production.

---

## Roadmap (not commitments, just things on the list)

* Drag-to-reorder for Active Projects config lists (currently add-order only)
* Normalize `loadProjects()` mapper — execution fields use snake_case while
  intake fields use camelCase; works but inconsistent
* Completed projects in Active Projects? Currently filtered to `status === 'Accepted'`
  only — may want a "Completed" lifecycle stage visible
* "Last updated" timestamp on the shareable status board
* Workspace switching / multi-workspace UI
* Real role differences between admin and PM (currently identical)
* Audit log retention policy (`sent_notifications` rows accumulate forever today)
* Rep-side notification preferences (deferred for product reasons; see above)
* Invitation expiry / cleanup (`workspace_invitations` accepted rows accumulate
  forever today; pending rows live until canceled or accepted)
* Inviter name in `member_invited` email body (currently says "An admin invited
  you" — could resolve `invited_by` via Auth Admin API to "Nick invited you")
* Insights / reporting tab (stakeholder and leadership reporting — parked until
  requirements are gathered from stakeholders)

---

## Tooling

* **Supabase CLI** for Edge Function deploys. Install: `brew install supabase/tap/supabase`.
* **Playwright** for tests.
* **Resend** for email delivery.
* **GitHub Pages** for hosting; **GitHub Actions** for CI.

No bundler, no linter config in repo. The HTML files are edited directly,
the Edge Function uses Deno's TypeScript-as-source model.

---

## Completed: v1.17.0 — Execution tracking arc

This section documents the execution tracking feature set completed in May 2026.
It replaces the manual Confluence board the team was using to track accepted projects.

### What was built

**Dashboard (new default landing page):** PM operations view with six metric cards
(Active projects, Unreviewed, At risk, Blocked, Overdue ETAs, Revisits) and four
attention widgets. Each widget row links to the relevant tab.

**Intake (renamed from Dashboard):** The existing submission review queue, unchanged
in functionality. List and Board views, status filters, search, inline detail panels.

**Active Projects tab:** Execution pipeline for accepted projects. Shows sponsor group,
platform, priority, lifecycle stage, execution status, ETA, and owner avatars. Four
filter dropdowns + search. Click any row to expand the detail panel with editable
execution fields. Owner chips use draft state — adding/removing owners doesn't clear
unsaved dropdown selections. Save button persists all fields at once.

**Active Projects config (⚙ → Active Projects config):** Six manageable dropdown
lists (sponsor groups, platforms, priorities, lifecycle stages, statuses, people
directory). Each item has a color swatch from a 9-color preset palette. Rename
auto-updates all projects using the old value. Delete with reassignment when items
are in use. Status board token section with copy link and regenerate (with confirmation).

**Shareable status board (`/arbiter/status/`):** Standalone HTML page for stakeholders.
Token-gated via URL parameter, validated by `validate_status_board_token` SECURITY
DEFINER RPC. Kanban board grouped by lifecycle stage. Cards show name, sponsor group,
platform, priority pill, status pill, ETA, owner avatars. Filter dropdowns for
platform, status, priority. No scores, tiers, or criteria data shown. Uses the real
Arbiter logo. Invalid/missing token shows a clean error message.

**Help tab & Tour:** All help topics updated for the new nav. New topics for Dashboard,
Intake, Active Projects, Shareable status board, and Active Projects config. QA
checklist expanded to 129 items with Dashboard (8) and Active Projects (10) sections.
Tour expanded from 4 to 10 steps covering every major area.

### Database changes (Migration 013)

Seven new columns on `projects`: `execution_sponsor_group`, `execution_platform`,
`execution_priority`, `execution_eta` (date), `execution_lifecycle`,
`execution_status`, `execution_owners` (text[]).

Seven new columns on `workspace_config`: six JSONB config lists storing
`[{label, bg, color}]` objects + `status_board_token` (text).

Two SECURITY DEFINER RPCs with anon EXECUTE grants:
* `validate_status_board_token(p_token text) returns boolean`
* `get_status_board_projects(p_token text) returns table(...)` — returns execution
  fields only, no scores

### Architecture decisions (don't re-litigate)

* Owners are NOT Arbiter users — just a PM-managed people directory (names only, no auth)
* All six execution config lists are fully manageable from Settings with rename,
  delete-with-reassignment, and reorder
* Shareable status board is a separate page, not embedded in nav
* Config list items store `{label, bg, color}` objects with preset palette picker
* Execution fields use Save button (not auto-save); owners use draft state
* Insights/Reporting tab parked until stakeholder requirements gathered
* The `loadProjects()` mapper uses camelCase for intake fields but snake_case for
  execution fields — this inconsistency works but could be normalized in a future pass

### Tests added (15 new specs, 91 total)

* Dashboard: 9 tests (default tab, empty state, metrics, all four widgets, navigation)
* Status board: 6 tests (invalid token, missing token, valid render, lifecycle grouping,
  no scores shown, filters)

### Open questions (from this arc)

* Should completed projects (intake status = Completed) appear in Active Projects?
  Currently filtered to `status === 'Accepted'` only.
* Config lists don't yet support drag-to-reorder — items render in order but
  reordering requires deleting and re-adding.
