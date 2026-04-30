-- ============================================================
-- 008-sent-notifications-audit.sql
--
-- Audit trail for transactional email notifications. Every
-- attempt by the notify Edge Function — successful, failed,
-- or skipped — gets a row.
--
-- Without this, "did the rep actually get my decision email?"
-- has no answer beyond Supabase function logs (which expire).
-- A persistent audit table lets admins surface notification
-- history in the UI and debug missing emails after the fact.
--
-- The function uses service-role to INSERT, bypassing RLS.
-- workspace_members can SELECT their workspace's rows for the
-- UI; nobody can UPDATE or DELETE (audit immutability).
-- ============================================================

BEGIN;

-- ──────────────────────────────────────────────────────────────
-- 1. Table
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sent_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- project_id can be null after the underlying project is deleted; we
  -- want the audit row to survive. ON DELETE SET NULL keeps history
  -- without orphaning.
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  recipient_email text NOT NULL,
  status text NOT NULL,
  error text,
  -- For project_updated, the list of fields that changed. JSON so we
  -- can extend the shape later (e.g. include before/after values).
  changes jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW(),

  CONSTRAINT sent_notifications_event_type_check
    CHECK (event_type IN ('new_submission', 'project_updated')),
  CONSTRAINT sent_notifications_status_check
    CHECK (status IN ('sent', 'failed', 'skipped_preference', 'skipped_self'))
);

-- Dominant access pattern is "recent notifications for this workspace"
CREATE INDEX IF NOT EXISTS idx_sent_notifications_workspace_created
  ON sent_notifications (workspace_id, created_at DESC);

-- ──────────────────────────────────────────────────────────────
-- 2. RLS
-- ──────────────────────────────────────────────────────────────

ALTER TABLE sent_notifications ENABLE ROW LEVEL SECURITY;

-- Members can read their workspace's audit log.
DROP POLICY IF EXISTS sent_notifications_select ON sent_notifications;
CREATE POLICY sent_notifications_select ON sent_notifications
  FOR SELECT
  TO authenticated
  USING (public.is_workspace_member(workspace_id));

-- No INSERT/UPDATE/DELETE policies for the authenticated role. The
-- Edge Function uses service-role which bypasses RLS, so it can write.
-- Authenticated users get no write paths — audit immutability.

-- ──────────────────────────────────────────────────────────────
-- 3. Verification
-- ──────────────────────────────────────────────────────────────

DO $$
DECLARE
  policy_count INT;
  index_count INT;
BEGIN
  SELECT COUNT(*) INTO policy_count
  FROM pg_policy
  WHERE polrelid = 'public.sent_notifications'::regclass;

  IF policy_count != 1 THEN
    RAISE EXCEPTION
      'Migration 008 verification failed: expected 1 policy on sent_notifications, got %',
      policy_count;
  END IF;

  SELECT COUNT(*) INTO index_count
  FROM pg_indexes
  WHERE tablename = 'sent_notifications'
  AND schemaname = 'public';

  -- Expecting at least: PK index + the workspace/created_at composite
  IF index_count < 2 THEN
    RAISE EXCEPTION
      'Migration 008 verification failed: expected at least 2 indexes, got %',
      index_count;
  END IF;

  RAISE NOTICE 'Migration 008 OK: sent_notifications table + 1 SELECT policy + indexes';
END;
$$;

COMMIT;
