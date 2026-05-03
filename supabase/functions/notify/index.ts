// supabase/functions/notify/index.ts
//
// Transactional email notifications for Arbiter.
//
// Three event types:
//   - new_submission: a rep submitted a new project. Email all workspace
//     members so any admin/PM knows there's something new to review.
//   - project_updated: a PM saved changes to a project. Email the rep
//     who originally submitted it so they know there's a decision or
//     status change.
//   - member_invited: an admin invited someone to the workspace.
//     Email the invitee with a sign-in link. The acceptance is automatic
//     on first sign-in via the trigger added in migration 011.
//
// Lookups use the service-role key to bypass RLS. The function itself
// is gated by Supabase Edge's default JWT-required setting — only
// authenticated callers can invoke. We don't additionally check the
// caller's identity against the project's workspace because:
//   - For new_submission, the caller is the rep who just inserted the
//     project. RLS already verified they had INSERT permission. If they
//     can insert, they can notify about that insert.
//   - For project_updated, the caller is the workspace member who just
//     saved a draft. RLS already verified UPDATE permission.
//   - For member_invited, the caller is the workspace admin who just
//     created the invitations row. RLS on workspace_invitations
//     (migration 011) already verified is_workspace_admin.
//
// Failures are logged in the response but don't fail the request.
// Partial success is still success.

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// ── Config (from Supabase secrets) ──
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const FROM_EMAIL = "Arbiter <noreply@mail.porterfieldtools.com>";
const APP_URL = "https://nickporterfieldfullsteam.github.io/arbiter";

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// ── Types ──
type EventBody =
  | { event_type: "new_submission"; project_id: string }
  | { event_type: "project_updated"; project_id: string; changes: string[] }
  | { event_type: "member_invited"; invitation_id: string };

type SendResult = { email: string; ok: boolean; error?: string };

// ── Email sending ──
async function sendEmail(
  to: string,
  subject: string,
  html: string,
): Promise<SendResult> {
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
    });
    if (!resp.ok) {
      const errBody = await resp.text();
      return { email: to, ok: false, error: `${resp.status}: ${errBody}` };
    }
    return { email: to, ok: true };
  } catch (err) {
    return { email: to, ok: false, error: String(err) };
  }
}

// ── Audit ──
//
// Records a notification attempt to the sent_notifications table. Wrapped
// in try/catch so audit failures never break the notification flow — the
// log is observability infrastructure, not part of the critical path.
async function recordAttempt(opts: {
  workspaceId: string;
  projectId: string | null;
  eventType: string;
  recipientEmail: string;
  status: "sent" | "failed" | "skipped_preference" | "skipped_self";
  error?: string;
  changes?: string[];
}): Promise<void> {
  try {
    const { error } = await sb.from("sent_notifications").insert({
      workspace_id: opts.workspaceId,
      project_id: opts.projectId,
      event_type: opts.eventType,
      recipient_email: opts.recipientEmail,
      status: opts.status,
      error: opts.error || null,
      changes: opts.changes || null,
    });
    if (error) {
      console.warn("[notify] audit insert failed:", error.message);
    }
  } catch (err) {
    console.warn("[notify] audit insert threw:", String(err));
  }
}

// ── HTML email builders ──
//
// Both share the same shell as the magic-link template: centered card,
// logo header, hero text, optional CTA button, footer. The body content
// differs per event type.

function emailShell(opts: {
  heading: string;
  intro: string;
  bodyHtml: string;
  ctaText?: string;
  ctaUrl?: string;
  footer?: string;
}): string {
  const cta = opts.ctaText && opts.ctaUrl
    ? `
      <tr>
        <td align="center" style="padding:8px 36px 24px;">
          <a href="${opts.ctaUrl}" style="display:inline-block; background:#1a1a1a; color:#ffffff; text-decoration:none; font-size:14px; font-weight:500; padding:12px 28px; border-radius:8px;">
            ${opts.ctaText}
          </a>
        </td>
      </tr>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${opts.heading}</title>
</head>
<body style="margin:0; padding:0; background:#f4f4f4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color:#1a1a1a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f4; padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff; border:1px solid #e5e5e5; border-radius:12px; max-width:520px; width:100%;">

          <tr>
            <td align="center" style="padding:36px 32px 16px;">
              <img src="${APP_URL}/assets/logo.png" width="56" height="49" alt="Arbiter" style="display:block; border:0; outline:none; text-decoration:none;">
              <div style="font-size:20px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:#1a1a1a; margin-top:12px;">Arbiter</div>
              <div style="font-size:12px; color:#888; margin-top:2px;">Make the call.</div>
            </td>
          </tr>

          <tr>
            <td style="padding:16px 36px 8px;">
              <h1 style="font-size:18px; font-weight:600; color:#1a1a1a; margin:16px 0 12px;">${opts.heading}</h1>
              <p style="font-size:14px; line-height:1.55; color:#444; margin:0 0 16px;">${opts.intro}</p>
              ${opts.bodyHtml}
            </td>
          </tr>

          ${cta}

          <tr>
            <td style="border-top:1px solid #f0f0ee; padding:18px 36px; background:#fafaf9; border-radius:0 0 12px 12px;">
              <p style="font-size:11px; line-height:1.5; color:#999; margin:0;">
                ${opts.footer || "You're receiving this because you're a member of an Arbiter workspace."}
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        c
      ]!),
  );
}

// ── Tier styling for new_submission emails (admin only — never sent to reps) ──
function tierPillStyle(tier: string): { bg: string; fg: string } {
  switch ((tier || "").toLowerCase()) {
    case "pursue":   return { bg: "#dcf2e3", fg: "#1a5f2e" };
    case "evaluate": return { bg: "#fef3c7", fg: "#92400e" };
    case "defer":    return { bg: "#fce4e4", fg: "#9b1c1c" };
    case "pass":     return { bg: "#f0f0ee", fg: "#666" };
    default:         return { bg: "#f0f0ee", fg: "#666" };
  }
}

// ── Status pill styling for project_updated (rep-facing — no scoring info) ──
function statusPillStyle(status: string): { bg: string; fg: string } {
  switch ((status || "").toLowerCase()) {
    case "accepted":     return { bg: "#dcf2e3", fg: "#1a5f2e" };
    case "under review": return { bg: "#dde7f3", fg: "#1e3a5f" };
    case "deferred":     return { bg: "#fef3c7", fg: "#92400e" };
    case "passed":       return { bg: "#f0f0ee", fg: "#666" };
    case "submitted":    return { bg: "#f0f0ee", fg: "#666" };
    default:             return { bg: "#f0f0ee", fg: "#666" };
  }
}

// Renders a horizontal progress bar via nested tables (cross-client safe).
// `value` 0-100, accent color for filled portion.
function progressBar(value: number, accent = "#d8612a"): string {
  const v = Math.max(0, Math.min(100, value));
  if (v === 0) {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eee; border-radius:4px;"><tr><td style="height:6px; line-height:6px; font-size:0;">&nbsp;</td></tr></table>`;
  }
  if (v === 100) {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${accent}; border-radius:4px;"><tr><td style="height:6px; line-height:6px; font-size:0;">&nbsp;</td></tr></table>`;
  }
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eee; border-radius:4px;">
      <tr>
        <td width="${v}%" style="background:${accent}; border-radius:4px 0 0 4px; height:6px; line-height:6px; font-size:0;">&nbsp;</td>
        <td width="${100 - v}%" style="height:6px; line-height:6px; font-size:0;">&nbsp;</td>
      </tr>
    </table>`;
}

function emailNewSubmission(
  project: any,
  config: any,
): { subject: string; html: string } {
  const projName = escapeHtml(project.name);
  const projType = escapeHtml(project.project_type || "");
  const customer = escapeHtml(project.locked_vals?.__customer__ || "");
  const submitter = escapeHtml(project.locked_vals?.__submitter__ || "");
  const submitterEmail = escapeHtml(project.submitter_email || "");
  const score = Number(project.score) || 0;
  const tier = (project.tier || "").toLowerCase();
  const tierLabel = tier ? tier.toUpperCase() : "—";
  const tierStyle = tierPillStyle(tier);

  const subject = `New submission: ${project.name}`;

  // Hero: project name + tier pill (no dark background — light treatment)
  const heroHtml = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;">
      <tr>
        <td style="padding:14px 18px; background:#fafaf9; border-radius:8px;">
          <div style="font-size:11px; font-weight:500; color:#888; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:6px;">New project request</div>
          <div style="font-size:20px; font-weight:600; color:#1a1a1a; margin-bottom:10px;">${projName}</div>
          <span style="display:inline-block; background:${tierStyle.bg}; color:${tierStyle.fg}; font-size:11px; font-weight:600; letter-spacing:0.05em; text-transform:uppercase; padding:4px 10px; border-radius:6px;">${escapeHtml(tierLabel)}</span>
        </td>
      </tr>
    </table>`;

  // Score band
  const scoreHtml = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">
      <tr>
        <td style="padding:14px 18px; background:#fff; border:1px solid #f0f0ee; border-radius:8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td width="80" valign="middle" style="padding-right:14px;">
                <div style="font-size:30px; font-weight:700; color:#1a1a1a; line-height:1;">${score}</div>
              </td>
              <td valign="middle">
                <div style="font-size:12px; color:#888; margin-bottom:6px;">Score out of 100</div>
                ${progressBar(score)}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>`;

  // Project details — locked fields first, then any custom detail_fields
  const detailRows: string[] = [];
  if (projType) detailRows.push(detailRow("Project type", projType));
  if (projName) detailRows.push(detailRow("Project / feature name", projName));
  if (submitter) detailRows.push(detailRow("Submitted by", submitter));
  if (submitterEmail) detailRows.push(detailRow("Submitter email", submitterEmail));
  if (customer) detailRows.push(detailRow("Customer / prospect", customer));

  const detailFields = (config?.detail_fields || []) as any[];
  const detailVals = project.detail_vals || {};
  for (const f of detailFields) {
    const v = detailVals[f.id];
    if (v == null || v === "") continue;
    detailRows.push(detailRow(f.label, String(v)));
  }

  const detailsHtml = detailRows.length === 0 ? "" : `
    <div style="font-size:11px; font-weight:500; color:#888; text-transform:uppercase; letter-spacing:0.05em; margin:24px 0 10px;">Project details</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${detailRows.join("")}
    </table>`;

  // Scoring breakdown
  const criteria = (config?.criteria || []) as any[];
  const criteriaVals = project.criteria_vals || {};
  const scoringRows: string[] = [];
  for (const crit of criteria) {
    const val = criteriaVals[crit.id];
    if (val == null) continue;
    // criteria_vals[id] is the score (1, 3, 5, 7, 10, etc), not an index.
    // Find the option whose score matches. (Same lookup the main app uses.)
    const opt = (crit.options || []).find((o: any) => o.score === val);
    if (!opt) continue;
    const optLabel = String(opt.label || "");
    const optScore = Number(opt.score) || 0;
    scoringRows.push(scoringRow(crit.label, optLabel, optScore));
  }

  const scoringHtml = scoringRows.length === 0 ? "" : `
    <div style="font-size:11px; font-weight:500; color:#888; text-transform:uppercase; letter-spacing:0.05em; margin:24px 0 10px;">Scoring breakdown</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${scoringRows.join("")}
    </table>`;

  const bodyHtml = heroHtml + scoreHtml + detailsHtml + scoringHtml;

  const html = emailShell({
    heading: "New project submission",
    intro: "A rep just submitted a project for review.",
    bodyHtml,
    ctaText: "Review in Arbiter",
    ctaUrl: APP_URL,
  });

  return { subject, html };
}

// Single labeled detail row in the project-details table.
function detailRow(label: string, value: string): string {
  return `
    <tr>
      <td width="42%" valign="top" style="padding:8px 0; font-size:13px; color:#888; border-bottom:1px solid #f0f0ee;">${escapeHtml(label)}</td>
      <td valign="top" style="padding:8px 0 8px 16px; font-size:13px; color:#1a1a1a; border-bottom:1px solid #f0f0ee; white-space:pre-wrap;">${escapeHtml(value)}</td>
    </tr>`;
}

// Single criterion row with answer label, mini progress bar, and N/10 score.
function scoringRow(label: string, optLabel: string, score: number): string {
  const pct = (score / 10) * 100;
  return `
    <tr>
      <td valign="middle" style="padding:8px 0; border-bottom:1px solid #f0f0ee;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td width="38%" valign="top" style="font-size:13px; color:#1a1a1a; padding-right:12px;">${escapeHtml(label)}</td>
            <td valign="top" style="font-size:13px; color:#666; padding-right:12px;">${escapeHtml(optLabel)}</td>
            <td width="100" valign="middle" style="padding-left:8px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td valign="middle" style="padding-right:8px;">${progressBar(pct)}</td>
                  <td valign="middle" width="32" align="right" style="font-size:12px; color:#888; white-space:nowrap;">${score}/10</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

function emailProjectUpdated(
  project: any,
  changes: string[],
): { subject: string; html: string } {
  const projName = escapeHtml(project.name);
  const status = project.status || "Submitted";
  const decisionNotes = project.decision_notes || "";
  const revisitDate = project.revisit_date || "";

  const sStyle = statusPillStyle(status);

  // Hero: project name only (no score, no tier — rep must not see those)
  const heroHtml = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">
      <tr>
        <td style="padding:14px 18px; background:#fafaf9; border-radius:8px;">
          <div style="font-size:11px; font-weight:500; color:#888; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:6px;">Your project</div>
          <div style="font-size:18px; font-weight:600; color:#1a1a1a;">${projName}</div>
        </td>
      </tr>
    </table>`;

  // What changed — only fields that were actually changed
  const changeRows: string[] = [];
  if (changes.includes("status")) {
    changeRows.push(`
      <tr>
        <td width="42%" valign="top" style="padding:10px 0; font-size:13px; color:#888; border-bottom:1px solid #f0f0ee;">New status</td>
        <td valign="top" style="padding:10px 0 10px 16px; border-bottom:1px solid #f0f0ee;">
          <span style="display:inline-block; background:${sStyle.bg}; color:${sStyle.fg}; font-size:12px; font-weight:600; padding:4px 10px; border-radius:6px;">${escapeHtml(status)}</span>
        </td>
      </tr>`);
  }
  if (changes.includes("decisionNotes") && decisionNotes) {
    changeRows.push(`
      <tr>
        <td width="42%" valign="top" style="padding:10px 0; font-size:13px; color:#888; border-bottom:1px solid #f0f0ee;">Notes from the team</td>
        <td valign="top" style="padding:10px 0 10px 16px; font-size:13px; color:#1a1a1a; white-space:pre-wrap; border-bottom:1px solid #f0f0ee;">${escapeHtml(decisionNotes)}</td>
      </tr>`);
  }
  if (changes.includes("revisitDate") && revisitDate) {
    changeRows.push(`
      <tr>
        <td width="42%" valign="top" style="padding:10px 0; font-size:13px; color:#888; border-bottom:1px solid #f0f0ee;">Revisit date</td>
        <td valign="top" style="padding:10px 0 10px 16px; font-size:13px; color:#1a1a1a; border-bottom:1px solid #f0f0ee;">${escapeHtml(revisitDate)}</td>
      </tr>`);
  }

  const subject = `Update on your project: ${project.name}`;

  const bodyHtml = heroHtml + `
    <div style="font-size:11px; font-weight:500; color:#888; text-transform:uppercase; letter-spacing:0.05em; margin:0 0 4px;">What changed</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${changeRows.join("")}
    </table>`;

  const html = emailShell({
    heading: "Update on your project",
    intro: "Your project request was updated by the team.",
    bodyHtml,
    footer: "You're receiving this because you submitted this project to Arbiter.",
  });

  return { subject, html };
}

function emailMemberInvited(opts: {
  workspaceName: string;
  role: string;
}): { subject: string; html: string } {
  const workspaceName = escapeHtml(opts.workspaceName);
  const role = escapeHtml(opts.role);

  // Friendly role label for the email body. The DB stores 'admin' / 'pm' /
  // 'viewer'; readers shouldn't see 'pm' as an opaque acronym.
  const roleLabel = (() => {
    switch ((opts.role || "").toLowerCase()) {
      case "admin":  return "Admin";
      case "pm":     return "PM";
      case "viewer": return "Viewer";
      default:       return role;
    }
  })();

  const subject = `You're invited to ${opts.workspaceName} on Arbiter`;

  // Hero: workspace name + role pill (light treatment, matches the
  // new_submission hero style).
  const heroHtml = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">
      <tr>
        <td style="padding:14px 18px; background:#fafaf9; border-radius:8px;">
          <div style="font-size:11px; font-weight:500; color:#888; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:6px;">Workspace invitation</div>
          <div style="font-size:20px; font-weight:600; color:#1a1a1a; margin-bottom:10px;">${workspaceName}</div>
          <span style="display:inline-block; background:#dde7f3; color:#1e3a5f; font-size:11px; font-weight:600; letter-spacing:0.05em; text-transform:uppercase; padding:4px 10px; border-radius:6px;">${escapeHtml(roleLabel)}</span>
        </td>
      </tr>
    </table>`;

  // Body copy — short and practical. Two facts the recipient needs:
  // (a) what they're being invited to, (b) how acceptance works.
  const explanationHtml = `
    <p style="font-size:14px; line-height:1.55; color:#444; margin:0 0 12px;">
      You've been invited to join <strong>${workspaceName}</strong> on Arbiter as a ${escapeHtml(roleLabel)}.
      Sign in with this email address to accept — your membership is added automatically.
    </p>
    <p style="font-size:13px; line-height:1.55; color:#666; margin:0 0 4px;">
      If you weren't expecting this invitation, you can safely ignore the email. No account is created until you sign in.
    </p>`;

  const bodyHtml = heroHtml + explanationHtml;

  const html = emailShell({
    heading: "You're invited to Arbiter",
    intro: "An admin added you to a workspace. Sign in with this email to accept.",
    bodyHtml,
    ctaText: "Sign in to Arbiter",
    ctaUrl: APP_URL,
    footer: "You're receiving this because someone invited this email address to an Arbiter workspace.",
  });

  return { subject, html };
}

// ── Recipient lookups ──
type WorkspaceMemberInfo = {
  email: string;
  prefs: Record<string, unknown>;
};

async function getWorkspaceMembers(
  workspaceId: string,
): Promise<WorkspaceMemberInfo[]> {
  const { data: members, error: mErr } = await sb
    .from("workspace_members")
    .select("user_id, notification_prefs")
    .eq("workspace_id", workspaceId);
  if (mErr) throw new Error(`workspace_members lookup failed: ${mErr.message}`);
  if (!members?.length) return [];

  // Build user_id -> prefs map
  const prefsByUserId = new Map<string, Record<string, unknown>>();
  for (const m of members) {
    prefsByUserId.set(m.user_id, m.notification_prefs || {});
  }

  // The supabase-js client's `.schema('auth').from('users')` doesn't work,
  // and the list_workspace_member_emails RPC depends on auth.uid() which
  // is NULL in service-role context. The Auth Admin API is the canonical
  // path: it's specifically designed for service-role contexts to query
  // auth users.
  //
  // listUsers paginates (default 50, max 1000). For small workspaces this
  // is fine — we just take the first page and filter. If a workspace ever
  // has thousands of users we'd need to paginate, but that's a future
  // problem.
  const { data: usersResp, error: uErr } = await sb.auth.admin.listUsers({
    perPage: 1000,
  });
  if (uErr) throw new Error(`auth admin listUsers failed: ${uErr.message}`);

  const result: WorkspaceMemberInfo[] = [];
  for (const u of usersResp.users) {
    if (!u.email) continue;
    const prefs = prefsByUserId.get(u.id);
    if (prefs === undefined) continue;
    result.push({ email: u.email, prefs });
  }
  return result;
}

// Default-true semantics: a missing/null pref means "subscribed".
// We only suppress when the pref is explicitly false.
function isSubscribed(prefs: Record<string, unknown>, eventType: string): boolean {
  return prefs[eventType] !== false;
}

// ── Main handler ──
// CORS headers — the function is called from browsers (main app on
// github.io, portal also on github.io, sometimes file:// during local
// testing). Origin restriction adds little since we already auth via
// JWT; allow * and let the auth check be the gate.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  // Preflight: respond with CORS headers and no body
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  let body: EventBody;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  if (!body.event_type) {
    return new Response(
      JSON.stringify({ error: "Missing event_type" }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }

  // Per-event validation. The required fields differ by event type, so
  // we validate inside each branch rather than gating everything on a
  // shared identifier upfront.
  let results: SendResult[] = [];
  let skipped = 0;

  if (body.event_type === "new_submission") {
    // Look up the project (full row — service-role bypasses RLS)
    const { data: project, error: pErr } = await sb
      .from("projects")
      .select("*")
      .eq("id", body.project_id)
      .maybeSingle();
    if (pErr || !project) {
      return new Response(
        JSON.stringify({ error: pErr?.message || "Project not found" }),
        { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    // Fetch workspace_config in parallel for detail/criteria labels
    const [members, configResult] = await Promise.all([
      getWorkspaceMembers(project.workspace_id),
      sb.from("workspace_config")
        .select("detail_fields, criteria")
        .eq("workspace_id", project.workspace_id)
        .maybeSingle(),
    ]);
    const config = configResult.data || {};
    if (!members.length) {
      return new Response(
        JSON.stringify({ sent: 0, skipped: "no workspace members" }),
        { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    // Split into "send" and "skip" buckets based on notification preferences.
    // Default-true: a member with no opinion gets the email.
    const toSend: string[] = [];
    const toSkip: string[] = [];
    for (const m of members) {
      if (isSubscribed(m.prefs, "new_submission")) {
        toSend.push(m.email);
      } else {
        toSkip.push(m.email);
      }
    }
    skipped = toSkip.length;

    const { subject, html } = emailNewSubmission(project, config);
    results = await Promise.all(
      toSend.map((email) => sendEmail(email, subject, html)),
    );

    // Audit every send result + every skip
    await Promise.all([
      ...results.map((r) =>
        recordAttempt({
          workspaceId: project.workspace_id,
          projectId: project.id,
          eventType: "new_submission",
          recipientEmail: r.email,
          status: r.ok ? "sent" : "failed",
          error: r.error,
        })
      ),
      ...toSkip.map((email) =>
        recordAttempt({
          workspaceId: project.workspace_id,
          projectId: project.id,
          eventType: "new_submission",
          recipientEmail: email,
          status: "skipped_preference",
        })
      ),
    ]);
  } else if (body.event_type === "project_updated") {
    // Look up the project (full row — service-role bypasses RLS)
    const { data: project, error: pErr } = await sb
      .from("projects")
      .select("*")
      .eq("id", body.project_id)
      .maybeSingle();
    if (pErr || !project) {
      return new Response(
        JSON.stringify({ error: pErr?.message || "Project not found" }),
        { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    if (!project.submitter_email) {
      return new Response(
        JSON.stringify({ sent: 0, skipped: "no submitter_email on project" }),
        { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }
    const changes = body.changes || [];
    if (!changes.length) {
      return new Response(
        JSON.stringify({ sent: 0, skipped: "no changes specified" }),
        { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }
    const { subject, html } = emailProjectUpdated(project, changes);
    results = [await sendEmail(project.submitter_email, subject, html)];
    // Audit
    await recordAttempt({
      workspaceId: project.workspace_id,
      projectId: project.id,
      eventType: "project_updated",
      recipientEmail: project.submitter_email,
      status: results[0].ok ? "sent" : "failed",
      error: results[0].error,
      changes,
    });
  } else if (body.event_type === "member_invited") {
    // Look up the invitation (service-role bypasses the workspace_invitations
    // RLS policies, which only let the workspace's admins SELECT).
    const { data: invitation, error: invErr } = await sb
      .from("workspace_invitations")
      .select("id, workspace_id, email, role, accepted_at")
      .eq("id", body.invitation_id)
      .maybeSingle();
    if (invErr || !invitation) {
      return new Response(
        JSON.stringify({ error: invErr?.message || "Invitation not found" }),
        { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }
    // Don't email already-accepted invitations. The admin UI shouldn't
    // allow this in practice — a resend on an accepted invitation makes
    // no sense — but we guard regardless.
    if (invitation.accepted_at) {
      return new Response(
        JSON.stringify({ sent: 0, skipped: "invitation already accepted" }),
        { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    // Look up the workspace name for the email subject and body.
    const { data: workspace, error: wErr } = await sb
      .from("workspaces")
      .select("name")
      .eq("id", invitation.workspace_id)
      .maybeSingle();
    if (wErr || !workspace) {
      return new Response(
        JSON.stringify({ error: wErr?.message || "Workspace not found" }),
        { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const { subject, html } = emailMemberInvited({
      workspaceName: workspace.name || "Arbiter",
      role: invitation.role,
    });
    results = [await sendEmail(invitation.email, subject, html)];
    // Audit. project_id is null here (no project context for an invite);
    // the column is nullable per migration 008's schema.
    await recordAttempt({
      workspaceId: invitation.workspace_id,
      projectId: null,
      eventType: "member_invited",
      recipientEmail: invitation.email,
      status: results[0].ok ? "sent" : "failed",
      error: results[0].error,
    });
  } else {
    return new Response(
      JSON.stringify({ error: `Unknown event_type: ${(body as any).event_type}` }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }

  const sent = results.filter((r) => r.ok).length;
  const failed = results.length - sent;
  return new Response(
    JSON.stringify({ sent, failed, skipped, results }),
    { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
  );
});
