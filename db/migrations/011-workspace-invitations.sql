-- ============================================================
-- 011-workspace-invitations.sql
--
-- Adds a pending-invite flow for workspace_members. Before this,
-- adding a member required them to have signed up first — the
-- find_user_id_by_email RPC returned null, and the admin UI
-- showed "No account exists with that email. Ask them to sign
-- up first." Coordination burden was on the admin: ask the
-- person to sign up, wait, check back, then add. This migration
-- closes that loop.
--
-- Schema choice: a separate workspace_invitations table rather
-- than nullable user_id on workspace_members. Keeps the two
-- concepts distinct (a member is a user; an invitation is a
-- promise). Mirrors the conventional pattern from Supabase,
-- GitHub, Slack — where invitations and memberships are
-- separate resources with separate lifecycles.
--
-- Acceptance model: auto-accept on first sign-in, via a trigger
-- on auth.users. When someone confirms their account, the
-- trigger looks up any workspace_invitations matching their
-- lowercased email and converts them into workspace_members
-- rows with the saved role. No "accept this invitation" screen;
-- the magic-link sign-in is the acceptance.
--
-- Token model: email-only, no separate UUID token. The
-- invitation email contains a link to the main app's sign-in
-- page; the magic-link auth is the credential. Anyone who can
-- prove they own the invited email address gets in. This is
-- equivalent in security to the rest of the app's auth model
-- (magic-link only) and avoids token-management complexity.
--
-- Reps remain unchanged. Reps are added directly to the reps
-- table by admins; their invitation pathway is the rep portal's
-- existing magic-link flow. This migration is for admin/PM/viewer
-- invites only.
--
-- Schema verification: this migration was written after querying
-- workspace_members's actual structure to confirm assumptions.
-- The role CHECK mirrors workspace_members's existing CHECK
-- (admin, pm, viewer), the UNIQUE (workspace_id, user_id)
-- constraint exists so the trigger's ON CONFLICT clause is
-- valid, and uuid_generate_v4 is used for the id default to
-- match the existing convention on workspace_members.id.
-- ============================================================

BEGIN;

-- ──────────────────────────────────────────────────────────────
-- 1. Table
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.workspace_invitations (
  id            uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id  uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  email         text        NOT NULL,
  role          text        NOT NULL CHECK (role IN ('admin', 'pm', 'viewer')),
  invited_by    uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  invited_at    timestamptz NOT NULL DEFAULT now(),
  accepted_at   timestamptz,
  CONSTRAINT workspace_invitations_email_lowercased CHECK (email = lower(email)),
  CONSTRAINT workspace_invitations_unique_pending UNIQUE (workspace_id, email)
);

CREATE INDEX IF NOT EXISTS workspace_invitations_email_idx
  ON public.workspace_invitations (email)
  WHERE accepted_at IS NULL;

COMMENT ON TABLE  public.workspace_invitations IS
  'Pending invitations for admin/PM membership. Auto-accepted by trigger on auth.users insert when a matching email signs up.';
COMMENT ON COLUMN public.workspace_invitations.email IS
  'Lowercased email of the invitee. Match is case-insensitive at the trigger.';
COMMENT ON COLUMN public.workspace_invitations.accepted_at IS
  'Set by the trigger when the invitee signs up. NULL = still pending.';

-- ──────────────────────────────────────────────────────────────
-- 2. RLS — admins manage invitations for their own workspaces
-- ──────────────────────────────────────────────────────────────

ALTER TABLE public.workspace_invitations ENABLE ROW LEVEL SECURITY;

-- SELECT: workspace admins see invitations for their workspaces.
CREATE POLICY workspace_invitations_select ON public.workspace_invitations
  FOR SELECT
  USING (public.is_workspace_admin(workspace_id));

-- INSERT: workspace admins create invitations for their workspaces.
CREATE POLICY workspace_invitations_insert ON public.workspace_invitations
  FOR INSERT
  WITH CHECK (public.is_workspace_admin(workspace_id));

-- DELETE: workspace admins cancel pending invitations for their workspaces.
CREATE POLICY workspace_invitations_delete ON public.workspace_invitations
  FOR DELETE
  USING (public.is_workspace_admin(workspace_id));

-- No UPDATE policy: invitations are immutable once created.
-- Cancel = delete. Resend = delete + reinsert (the email is the
-- only client-facing action and it doesn't need DB state to repeat).

-- ──────────────────────────────────────────────────────────────
-- 3. Auto-accept trigger
-- ──────────────────────────────────────────────────────────────

-- Fires on every confirmed auth.users insert. Looks up matching
-- pending invitations by lowercased email, inserts a
-- workspace_members row for each, and marks the invitation
-- accepted. SECURITY DEFINER because auth.users triggers run as
-- the auth role and need to write to public.workspace_members.

CREATE OR REPLACE FUNCTION public.accept_workspace_invitations_for_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text;
  inv     record;
BEGIN
  -- auth.users.email may be NULL for some sign-up paths (e.g. phone-only).
  -- Skip silently if so; nothing to match against.
  v_email := lower(NEW.email);
  IF v_email IS NULL THEN
    RETURN NEW;
  END IF;

  FOR inv IN
    SELECT id, workspace_id, role
    FROM public.workspace_invitations
    WHERE email = v_email
      AND accepted_at IS NULL
  LOOP
    -- Insert the membership. ON CONFLICT DO NOTHING handles the edge
    -- case where the user is somehow already a member (e.g. they were
    -- added directly by another admin between invite and sign-up).
    INSERT INTO public.workspace_members (workspace_id, user_id, role)
    VALUES (inv.workspace_id, NEW.id, inv.role)
    ON CONFLICT (workspace_id, user_id) DO NOTHING;

    -- Mark the invitation accepted regardless. If the conflict happened,
    -- we still want the invitation off the pending list.
    UPDATE public.workspace_invitations
    SET accepted_at = now()
    WHERE id = inv.id;
  END LOOP;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.accept_workspace_invitations_for_new_user() FROM PUBLIC;

-- The trigger itself. AFTER INSERT so the user row exists before we
-- reference it. Fires once per new auth.users row.
DROP TRIGGER IF EXISTS accept_workspace_invitations_trigger ON auth.users;
CREATE TRIGGER accept_workspace_invitations_trigger
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.accept_workspace_invitations_for_new_user();

-- ──────────────────────────────────────────────────────────────
-- 4. Helper RPC for the admin UI
-- ──────────────────────────────────────────────────────────────

-- Returns the pending invitation matching an email, scoped to a
-- workspace the caller is admin of. Used by the member-add UI to
-- detect "this email is already invited" before re-sending.
-- SECURITY DEFINER but the WHERE clause on is_workspace_admin gates
-- access to the caller's own admin workspaces.

CREATE OR REPLACE FUNCTION public.find_pending_invitation_by_email(
  p_workspace_id uuid,
  p_email        text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.is_workspace_admin(p_workspace_id) THEN
    RAISE EXCEPTION 'Caller is not an admin of workspace %', p_workspace_id;
  END IF;

  SELECT id INTO v_id
  FROM public.workspace_invitations
  WHERE workspace_id = p_workspace_id
    AND email = lower(p_email)
    AND accepted_at IS NULL
  LIMIT 1;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.find_pending_invitation_by_email(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.find_pending_invitation_by_email(uuid, text) TO authenticated;

-- ──────────────────────────────────────────────────────────────
-- 5. Verification
-- ──────────────────────────────────────────────────────────────

DO $$
DECLARE
  table_exists      boolean;
  trigger_exists    boolean;
  trigger_func_ok   boolean;
  rpc_exists        boolean;
  policy_count      int;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'workspace_invitations'
  ) INTO table_exists;
  IF NOT table_exists THEN
    RAISE EXCEPTION 'Migration 011 verification failed: workspace_invitations table not present';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'accept_workspace_invitations_trigger'
      AND tgrelid = 'auth.users'::regclass
  ) INTO trigger_exists;
  IF NOT trigger_exists THEN
    RAISE EXCEPTION 'Migration 011 verification failed: trigger on auth.users not present';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'accept_workspace_invitations_for_new_user'
      AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
  ) INTO trigger_func_ok;
  IF NOT trigger_func_ok THEN
    RAISE EXCEPTION 'Migration 011 verification failed: trigger function not present';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'find_pending_invitation_by_email'
      AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
  ) INTO rpc_exists;
  IF NOT rpc_exists THEN
    RAISE EXCEPTION 'Migration 011 verification failed: find_pending_invitation_by_email RPC not present';
  END IF;

  SELECT count(*) INTO policy_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'workspace_invitations';
  IF policy_count < 3 THEN
    RAISE EXCEPTION
      'Migration 011 verification failed: expected 3 RLS policies on workspace_invitations, found %',
      policy_count;
  END IF;

  RAISE NOTICE 'Migration 011 OK: workspace_invitations table + auto-accept trigger + admin RPC';
END;
$$;

COMMIT;
