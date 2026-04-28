-- ============================================================
-- 006-workspace-members-management.sql
--
-- Enables admin/PM management UI for the workspace.
--
-- Before this migration, workspace_members had only one policy:
--   "Members can read workspace membership" — USING (user_id = auth.uid())
-- which meant each user could see only their own membership row, and
-- nothing in the table could be modified from the client (no INSERT,
-- UPDATE, or DELETE policies).
--
-- After this migration:
--   1. Members can SELECT all rows for any workspace they're a member of
--      (so the management UI can list co-members).
--   2. Admins can INSERT, UPDATE, and DELETE rows in their workspace,
--      EXCEPT they cannot modify their own row.
--   3. A find_user_id_by_email RPC lets the management UI look up an
--      auth user by email without exposing auth.users directly.
--
-- Self-modification is blocked at the policy level (stricter than UI-only
-- enforcement). This means admins can't demote or remove themselves —
-- another admin must do it. Phase 1 ships with single-admin workspaces,
-- so this is a future-proofing constraint that doesn't affect today's
-- usage.
-- ============================================================

BEGIN;

-- ──────────────────────────────────────────────────────────────
-- 1. Replace the SELECT policy
-- ──────────────────────────────────────────────────────────────

-- Drop the old self-only policy
DROP POLICY IF EXISTS "Members can read workspace membership" ON workspace_members;
-- Idempotent: also drop the new name in case migration is re-run
DROP POLICY IF EXISTS workspace_members_select ON workspace_members;

-- New SELECT: members can see all rows for workspaces they belong to.
-- Self-referencing EXISTS is safe because the inner query is also RLS'd
-- to "see your own row" — which is sufficient to satisfy the EXISTS for
-- workspaces where you're a member.
CREATE POLICY workspace_members_select ON workspace_members
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM workspace_members self
      WHERE self.workspace_id = workspace_members.workspace_id
      AND self.user_id = auth.uid()
    )
  );

-- ──────────────────────────────────────────────────────────────
-- 2. Admin-only write policies (cannot modify self)
-- ──────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS workspace_members_admin_insert ON workspace_members;
CREATE POLICY workspace_members_admin_insert ON workspace_members
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM workspace_members self
      WHERE self.workspace_id = workspace_members.workspace_id
      AND self.user_id = auth.uid()
      AND self.role = 'admin'
    )
  );

DROP POLICY IF EXISTS workspace_members_admin_update ON workspace_members;
CREATE POLICY workspace_members_admin_update ON workspace_members
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM workspace_members self
      WHERE self.workspace_id = workspace_members.workspace_id
      AND self.user_id = auth.uid()
      AND self.role = 'admin'
    )
    AND user_id != auth.uid()
  );

DROP POLICY IF EXISTS workspace_members_admin_delete ON workspace_members;
CREATE POLICY workspace_members_admin_delete ON workspace_members
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM workspace_members self
      WHERE self.workspace_id = workspace_members.workspace_id
      AND self.user_id = auth.uid()
      AND self.role = 'admin'
    )
    AND user_id != auth.uid()
  );

-- ──────────────────────────────────────────────────────────────
-- 3. RPC: find_user_id_by_email
--
-- Returns the auth.users.id for a given email if a confirmed user
-- exists. Returns NULL otherwise. SECURITY DEFINER lets it read
-- auth.users which is normally inaccessible from the client.
--
-- Restricted to authenticated role — anonymous callers get nothing.
-- The function is a thin lookup with no side effects; it doesn't
-- check workspace permissions because the subsequent INSERT into
-- workspace_members is itself gated by the admin policy above.
-- ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.find_user_id_by_email(p_email text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, auth
STABLE
AS $$
  SELECT id
  FROM auth.users
  WHERE LOWER(email) = LOWER(p_email)
  AND email_confirmed_at IS NOT NULL
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.find_user_id_by_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.find_user_id_by_email(text) TO authenticated;

-- ──────────────────────────────────────────────────────────────
-- 4. RPC: list_workspace_member_emails
--
-- Returns (user_id, email) pairs for every member of the given
-- workspace IFF the caller is also a member of that workspace.
-- The "is also a member" check is enforced inside the function
-- (rather than relying solely on RLS) because we need to read
-- auth.users — a SECURITY DEFINER context skips RLS by default.
--
-- Without this gate, ANY authenticated user could call this with
-- ANY workspace_id and read everyone's email. That's the kind of
-- exfiltration vector SECURITY DEFINER functions create if you're
-- not careful.
-- ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.list_workspace_member_emails(p_workspace_id uuid)
RETURNS TABLE (user_id uuid, email text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, auth
STABLE
AS $$
  SELECT u.id AS user_id, u.email::text AS email
  FROM auth.users u
  JOIN workspace_members wm ON wm.user_id = u.id
  WHERE wm.workspace_id = p_workspace_id
  AND EXISTS (
    -- Caller must be a member of the workspace they're asking about.
    SELECT 1 FROM workspace_members caller
    WHERE caller.workspace_id = p_workspace_id
    AND caller.user_id = auth.uid()
  );
$$;

REVOKE ALL ON FUNCTION public.list_workspace_member_emails(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_workspace_member_emails(uuid) TO authenticated;

-- ──────────────────────────────────────────────────────────────
-- 5. Verification
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
      'Migration 006 verification failed: expected 4 policies on workspace_members, got %',
      policy_count;
  END IF;

  SELECT COUNT(*) INTO func_count
  FROM pg_proc
  WHERE proname IN ('find_user_id_by_email', 'list_workspace_member_emails')
  AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public');

  IF func_count != 2 THEN
    RAISE EXCEPTION
      'Migration 006 verification failed: expected 2 RPC functions, got %',
      func_count;
  END IF;

  RAISE NOTICE 'Migration 006 OK: 4 policies on workspace_members + 2 RPC functions';
END;
$$;

COMMIT;
