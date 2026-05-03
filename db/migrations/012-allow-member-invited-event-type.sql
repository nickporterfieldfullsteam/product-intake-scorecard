-- ============================================================
-- 012-allow-member-invited-event-type.sql
--
-- The sent_notifications.event_type column has a CHECK constraint
-- that whitelists exactly two values: 'new_submission' and
-- 'project_updated'. The pending-invite flow introduced in
-- migration 011 needs a third event type, 'member_invited',
-- that the notify Edge Function will write audit rows for.
--
-- This migration widens the constraint to accept the new value.
-- It must land before the Edge Function deploy, or the audit
-- inserts for member_invited events will fail the CHECK and the
-- function's try/catch will swallow them — emails would still
-- send, but no audit trail would record anything.
--
-- Schema verification: this migration was written after querying
-- sent_notifications's actual constraints to confirm the existing
-- CHECK definition. The widened constraint preserves the original
-- two values exactly and adds one new value.
-- ============================================================

BEGIN;

-- ──────────────────────────────────────────────────────────────
-- 1. Drop and recreate the CHECK constraint
-- ──────────────────────────────────────────────────────────────
--
-- Postgres has no "alter check constraint" — drop and recreate
-- is the standard pattern. Both operations are metadata-only
-- (no row scan required), so this runs in milliseconds.

ALTER TABLE public.sent_notifications
  DROP CONSTRAINT IF EXISTS sent_notifications_event_type_check;

ALTER TABLE public.sent_notifications
  ADD CONSTRAINT sent_notifications_event_type_check
  CHECK (event_type IN ('new_submission', 'project_updated', 'member_invited'));

-- ──────────────────────────────────────────────────────────────
-- 2. Verification
-- ──────────────────────────────────────────────────────────────

DO $$
DECLARE
  check_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO check_def
  FROM pg_constraint
  WHERE conname = 'sent_notifications_event_type_check'
    AND conrelid = 'public.sent_notifications'::regclass;

  IF check_def IS NULL THEN
    RAISE EXCEPTION
      'Migration 012 verification failed: sent_notifications_event_type_check constraint not present';
  END IF;

  IF check_def NOT LIKE '%member_invited%' THEN
    RAISE EXCEPTION
      'Migration 012 verification failed: constraint does not include member_invited (current: %)',
      check_def;
  END IF;

  IF check_def NOT LIKE '%new_submission%' OR check_def NOT LIKE '%project_updated%' THEN
    RAISE EXCEPTION
      'Migration 012 verification failed: constraint dropped existing values (current: %)',
      check_def;
  END IF;

  RAISE NOTICE 'Migration 012 OK: sent_notifications.event_type now accepts new_submission, project_updated, member_invited';
END;
$$;

COMMIT;
