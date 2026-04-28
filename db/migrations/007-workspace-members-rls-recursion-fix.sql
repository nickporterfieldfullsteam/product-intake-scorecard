-- ============================================================
-- 007-workspace-members-rls-recursion-fix.sql
--
-- Fixes a bug introduced by migration 006: workspace_members
-- queries were silently returning empty results.
--
-- Root cause: migration 006's SELECT/INSERT/UPDATE/DELETE policies
-- on workspace_members reference workspace_members itself in their
-- EXISTS subqueries:
--
--   USING (
--     EXISTS (SELECT 1 FROM workspace_members self
--             WHERE self.workspace_id = workspace_members.workspace_id
--             AND self.user_id = auth.uid())
--   )
--
-- The inner query is also RLS-evaluated. Postgres detects the
-- recursive policy reference and short-circuits to "no rows
-- visible" rather than infinite-looping. Net effect: the policy
-- denies everything.
--
-- Fix: introduce a SECURITY DEFINER helper that checks membership
-- without going through RLS. The helper takes a workspace_id and
-- returns a boolean about the CALLER's membership only — so it
-- can't be used to leak data about other users.
--
-- Recreate the four policies on workspace_members to use the
-- helper instead of recursive EXISTS.
-- ============================================================

BEGIN;

-- ──────────────────────────────────────────────────────────────
-- 1. Helper: is the caller a member of the given workspace?
-- ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_workspace_member(p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM workspace_members
    WHERE workspace_id = p_workspace_id
    AND user_id = auth.uid()
  );
$$;

REVOKE ALL ON FUNCTION public.is_workspace_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_workspace_member(uuid) TO authenticated;

-- ──────────────────────────────────────────────────────────────
-- 2. Helper: is the caller an admin of the given workspace?
-- ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_workspace_admin(p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM workspace_members
    WHERE workspace_id = p_workspace_id
    AND user_id = auth.uid()
    AND role = 'admin'
  );
$$;

REVOKE ALL ON FUNCTION public.is_workspace_admin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_workspace_admin(uuid) TO authenticated;

-- ──────────────────────────────────────────────────────────────
-- 3. Recreate the four policies, using the helpers
-- ──────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS workspace_members_select ON workspace_members;
DROP POLICY IF EXISTS workspace_members_admin_insert ON workspace_members;
DROP POLICY IF EXISTS workspace_members_admin_update ON workspace_members;
DROP POLICY IF EXISTS workspace_members_admin_delete ON workspace_members;

-- Members can see all rows for workspaces they belong to
CREATE POLICY workspace_members_select ON workspace_members
  FOR SELECT
  TO authenticated
  USING (public.is_workspace_member(workspace_id));

-- Admins can add new members to their workspace
CREATE POLICY workspace_members_admin_insert ON workspace_members
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_workspace_admin(workspace_id));

-- Admins can update roles in their workspace, but not their own row
CREATE POLICY workspace_members_admin_update ON workspace_members
  FOR UPDATE
  TO authenticated
  USING (
    public.is_workspace_admin(workspace_id)
    AND user_id != auth.uid()
  );

-- Admins can remove members from their workspace, but not themselves
CREATE POLICY workspace_members_admin_delete ON workspace_members
  FOR DELETE
  TO authenticated
  USING (
    public.is_workspace_admin(workspace_id)
    AND user_id != auth.uid()
  );

-- ──────────────────────────────────────────────────────────────
-- 4. Verification
-- ──────────────────────────────────────────────────────────────

DO $$
DECLARE
  policy_count INT;
  func_count INT;
BEGIN
  SELECT COUNT(*) INTO policy_count
  FROM pg_policy
  WHERE polrelid = 'public.workspace_members'::regclass;

  IF policy_count != 4 THEN
    RAISE EXCEPTION
      'Migration 007 verification failed: expected 4 policies, got %',
      policy_count;
  END IF;

  SELECT COUNT(*) INTO func_count
  FROM pg_proc
  WHERE proname IN ('is_workspace_member', 'is_workspace_admin')
  AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public');

  IF func_count != 2 THEN
    RAISE EXCEPTION
      'Migration 007 verification failed: expected 2 helper functions, got %',
      func_count;
  END IF;

  RAISE NOTICE 'Migration 007 OK: 4 policies + 2 SECURITY DEFINER helpers';
END;
$$;

COMMIT;
