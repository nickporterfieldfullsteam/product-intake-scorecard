-- ============================================================
-- 010-drop-sales-help-topics.sql
--
-- Drops the orphaned sales_help_topics JSONB column from
-- workspace_config. The column was added back during the
-- exported-sales-form era to persist the editable help topics
-- shown in the form's ? help button.
--
-- That feature was removed in v1.15 (the EmailJS removal arc),
-- and the corresponding JS — DEFAULT_SALES_HELP, salesHelpTopics,
-- renderSalesHelpEditor, and the persist/load wiring — was
-- removed from index.html in v1.15.3. The column has been dead
-- weight ever since: nothing reads it, nothing writes it.
--
-- Why drop instead of leaving alone: keeping orphaned columns in
-- the schema confuses future readers. A new dev looking at
-- workspace_config will assume sales_help_topics is meaningful
-- and waste time figuring out what feeds it. Better to remove it
-- now while the context is fresh.
--
-- Risk profile: very low. Production has no JS reading the column
-- (verified: greps for 'sales_help_topics' and 'salesHelpTopics'
-- in index.html and portal/index.html return zero hits as of
-- v1.15.3). DROP COLUMN takes an ACCESS EXCLUSIVE lock on
-- workspace_config, but the table is small (one row per workspace)
-- and the migration runs in milliseconds.
--
-- Settings backups exported pre-v1.15.3 will still contain a
-- 'salesHelpTopics' key in their JSON. The import handler in
-- index.html no longer reads that key, so old backups simply
-- ignore it on import — no errors, no data loss for anything
-- that still matters.
-- ============================================================

BEGIN;

-- ──────────────────────────────────────────────────────────────
-- 1. Drop the column
-- ──────────────────────────────────────────────────────────────

ALTER TABLE workspace_config
  DROP COLUMN IF EXISTS sales_help_topics;

-- ──────────────────────────────────────────────────────────────
-- 2. Verification
-- ──────────────────────────────────────────────────────────────

DO $$
DECLARE
  col_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'workspace_config'
      AND column_name = 'sales_help_topics'
  ) INTO col_exists;

  IF col_exists THEN
    RAISE EXCEPTION
      'Migration 010 verification failed: sales_help_topics column still present on workspace_config';
  END IF;

  RAISE NOTICE 'Migration 010 OK: sales_help_topics column dropped from workspace_config';
END;
$$;

COMMIT;
