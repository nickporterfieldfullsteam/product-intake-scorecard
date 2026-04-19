import { test as base, expect, Page } from '@playwright/test';

/**
 * Portal-specific test fixtures.
 *
 * Why a separate fixture from the main-app one: the portal lives at
 * /portal/index.html, uses its own Supabase session key, and has no
 * concept of the main app's workspace_members-based admin gate. Tests
 * that exercise the portal shouldn't pay the cost of the main-app
 * cleanTestWorkspace step, and shouldn't sign in via the main app's
 * password-auth UI (the portal is magic-link only).
 */

type PortalFixtures = {
  /** Bare portal page — no session, no URL params. */
  portalPage: Page;

  /** Portal page with a fake session seeded in localStorage. */
  seededPortalPage: Page;
};

/**
 * The localStorage key Supabase uses for its session.
 * Format: sb-<project-ref>-auth-token
 */
const SUPABASE_PROJECT_REF = 'evjvdfqpsbnpfsmzhpfn';
const SB_AUTH_KEY = `sb-${SUPABASE_PROJECT_REF}-auth-token`;

/**
 * Resolve the portal URL from the test target's baseURL.
 * Mirrors the logic in the main-app fixture but targets /portal/ instead
 * of /index.html.
 */
export function resolvePortalURL(baseURL: string): string {
  if (baseURL.startsWith('file://')) {
    // file:// baseURL points at index.html; swap for portal/index.html
    return baseURL.replace(/\/index\.html$/, '/portal/index.html');
  }
  if (baseURL.endsWith('/')) {
    return baseURL + 'portal/index.html';
  }
  return baseURL + '/portal/index.html';
}

/**
 * Seed a fake Supabase session into localStorage. Enough to convince the
 * portal's `getSession()` check to treat the user as signed in. The
 * access_token is fabricated, so any actual API call will be rejected by
 * the server — but B.1 doesn't make any, so this is sufficient.
 *
 * For later phases, replace this with a real token acquired by signing
 * in as the test user via Supabase's admin API.
 */
export async function seedFakeSession(page: Page, email: string = 'test-rep@arbiter.test') {
  await page.addInitScript(
    ({ key, email }) => {
      // Structure matches what @supabase/supabase-js v2 writes to localStorage
      const session = {
        access_token: 'fake-access-token-' + Date.now(),
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: 'fake-refresh-token',
        user: {
          id: '00000000-0000-0000-0000-000000000000',
          aud: 'authenticated',
          role: 'authenticated',
          email: email,
          email_confirmed_at: new Date().toISOString(),
          phone: '',
          confirmed_at: new Date().toISOString(),
          last_sign_in_at: new Date().toISOString(),
          app_metadata: { provider: 'email', providers: ['email'] },
          user_metadata: { email },
          identities: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      };
      localStorage.setItem(key, JSON.stringify(session));
    },
    { key: SB_AUTH_KEY, email }
  );
}

/** Clear any portal-related state from localStorage. */
export async function clearPortalStorage(page: Page) {
  await page.evaluate(() => {
    Object.keys(localStorage)
      .filter(k => k.startsWith('sb-'))
      .forEach(k => localStorage.removeItem(k));
  });
}

export const test = base.extend<PortalFixtures>({
  portalPage: async ({ page, baseURL }, use) => {
    const url = resolvePortalURL(baseURL!);
    await page.goto(url);

    // Ensure no stale session from a previous test
    await clearPortalStorage(page);
    await page.reload();

    await use(page);
  },

  seededPortalPage: async ({ page, baseURL }, use) => {
    await seedFakeSession(page);
    const url = resolvePortalURL(baseURL!);
    await page.goto(url);
    await use(page);
  },
});

export { expect };
