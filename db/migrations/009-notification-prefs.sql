-- ============================================================
-- 009-notification-prefs.sql
--
-- Lets a workspace member opt out of new_submission notifications.
-- Deferred decision: rep-side opt-out (project_updated) — reps
-- almost always want to know when their project's status changes,
-- and the policy implications of letting reps update their own row
-- are different. Future migration if we ever need it.
--
-- Schema: a JSONB column on workspace_members rather than a separate
-- table. Preferences are 1:1 with membership and have no independent
-- lifecycle. JSONB gives flexibility to add new event types without
-- new migrations.
--
-- Default '{"new_submission": true}' (subscribed) keeps existing
-- members behaving as before. Filtering uses default-true semantics:
-- the function treats missing/null keys as "subscribed."
--
-- Self-update path: an RPC rather than a column-level RLS rule.
-- Postgres RLS policies can't easily restrict updates to specific
-- columns; an RPC is cleaner and validates intent ("update MY prefs").
-- ============================================================

BEGIN;

-- ──────────────────────────────────────────────────────────────
-- 1. Column
-- ──────────────────────────────────────────────────────────────

ALTER TABLE workspace_members
  ADD COLUMN IF NOT EXISTS notification_prefs jsonb
  NOT NULL DEFAULT '{"new_submission": true}'::jsonb;

-- ──────────────────────────────────────────────────────────────
-- 2. RPC: update the caller's own notification preferences
-- ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.update_my_notification_prefs(
  p_workspace_id uuid,
  p_prefs jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_updated jsonb;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Only let the caller update THEIR OWN row in the given workspace.
  -- The RPC is SECURITY DEFINER so the UPDATE bypasses RLS, but the
  -- WHERE clause locks it to the caller's user_id — no privilege
  -- escalation possible.
  UPDATE workspace_members
  SET notification_prefs = p_prefs
  WHERE workspace_id = p_workspace_id
    AND user_id = v_user_id
  RETURNING notification_prefs INTO v_updated;

  IF v_updated IS NULL THEN
    RAISE EXCEPTION 'Caller is not a member of workspace %', p_workspace_id;
  END IF;

  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.update_my_notification_prefs(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_my_notification_prefs(uuid, jsonb) TO authenticated;

-- ──────────────────────────────────────────────────────────────
-- 3. Verification
-- ──────────────────────────────────────────────────────────────

DO $$
DECLARE
  col_exists boolean;
  func_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'workspace_members'
      AND column_name = 'notification_prefs'
  ) INTO col_exists;

  IF NOT col_exists THEN
    RAISE EXCEPTION
      'Migration 009 verification failed: notification_prefs column not present';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'update_my_notification_prefs'
      AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
  ) INTO func_exists;

  IF NOT func_exists THEN
    RAISE EXCEPTION
      'Migration 009 verification failed: update_my_notification_prefs function not present';
  END IF;

  RAISE NOTICE 'Migration 009 OK: notification_prefs column + update_my_notification_prefs RPC';
END;
$$;

COMMIT;
