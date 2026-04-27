-- ============================================================
-- 005-rep-self-select-rls-fix.sql
--
-- Fixes a silent RLS denial that prevented authenticated reps
-- from loading their workspace_config (and consequently rendering
-- the portal submit form).
--
-- Discovered: 2026-04-27 (after Resend custom-domain rollout
-- enabled real reps to sign in via the portal for the first time).
--
-- Root cause:
--   The workspace_config SELECT policy allows access to either:
--     (a) workspace_members (admins/PMs)
--     (b) authenticated users who match an active row in `reps`
--          via `r.email = auth.email() AND r.is_active = true`
--
--   Branch (b) is a correlated EXISTS subquery into `reps`, which
--   itself is RLS-protected. The `reps` table had only two policies:
--     - "PMs can manage reps" (TO PUBLIC, gated on workspace_members)
--     - "reps_anon_auth_check" (TO anon, used by C.2 pre-auth check)
--
--   No policy allowed an `authenticated` rep to see their OWN row.
--   So the EXISTS subquery in the workspace_config policy returned
--   false even when the rep's row physically existed and matched.
--
--   Result: silent RLS denial on workspace_config, returns 0 rows,
--   portal form renders empty.
--
-- Fix:
--   Add a SELECT policy on `reps` scoped to authenticated users that
--   lets each rep see their own row by email. Surgical: no listing of
--   other reps, no data leak. PMs/admins still manage all reps via
--   their existing PUBLIC policy.
-- ============================================================

BEGIN;

-- Idempotent: drop if already exists (in case of re-run or partial apply)
DROP POLICY IF EXISTS reps_self_select ON reps;

CREATE POLICY reps_self_select ON reps
  FOR SELECT
  TO authenticated
  USING (email = auth.email());

-- Verification: confirm the policy is now present
DO $$
DECLARE
  policy_count INT;
BEGIN
  SELECT COUNT(*) INTO policy_count
  FROM pg_policy
  WHERE polrelid = 'public.reps'::regclass
  AND polname = 'reps_self_select';

  IF policy_count = 0 THEN
    RAISE EXCEPTION 'Migration 005 failed: reps_self_select policy not created';
  END IF;
  RAISE NOTICE 'Migration 005 OK: reps_self_select policy in place';
END;
$$;

COMMIT;
