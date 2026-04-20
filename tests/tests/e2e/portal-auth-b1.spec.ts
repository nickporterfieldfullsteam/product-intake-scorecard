import { test, expect, resolvePortalURL, seedFakeSession } from '../helpers/portal';

/**
 * Phase 3 Step B.1 — Portal auth gate tests.
 *
 * What this covers:
 *  1. Fresh load shows the sign-in view
 *  2. ?r=<base64> token pre-fills the email field (backwards-compat)
 *  3. Malformed ?r= param is gracefully ignored (no crash, empty form)
 *  4. signInWithOtp is dispatched when the button is clicked
 *  5. Existing session causes the signed-in view to render
 *  6. Sign out returns to the sign-in view
 *
 * What this does NOT cover:
 *  - Real email delivery. We intercept the OTP network call; no actual
 *    email is sent during tests.
 *  - Magic-link callback URL processing. The callback comes from clicking
 *    a link in an email, which Playwright can't simulate directly. The
 *    equivalent for our purposes is "session already in localStorage,"
 *    which is what test 5 verifies.
 *  - RLS enforcement. That's tested at the Supabase level via the
 *    migration sanity checks; the portal just reads whatever Supabase
 *    returns.
 */

test.describe('Phase 3 B.1 — Portal auth gate', () => {
  test('Fresh load shows the sign-in view', async ({ portalPage }) => {
    // After the fixture's navigate+clearStorage+reload, we should see
    // the empty sign-in form.
    await expect(portalPage.locator('#view-signin')).toBeVisible();
    await expect(portalPage.locator('#view-signed-in')).toBeHidden();
    await expect(portalPage.locator('#view-link-sent')).toBeHidden();
    await expect(portalPage.locator('#signin-email')).toHaveValue('');
  });

  test('?r= token pre-fills the email field', async ({ page, baseURL }) => {
    // The existing intake form URLs use ?r=<base64 of {name, email}>.
    // The portal honors this format for email pre-fill on first visit.
    //
    // Construct the base64 payload matching the existing format:
    //   base64({"name":"Test Rep","email":"test-rep@example.com"})
    const payload = { name: 'Test Rep', email: 'test-rep@example.com' };
    const token = Buffer.from(JSON.stringify(payload)).toString('base64');

    await page.goto(resolvePortalURL(baseURL!) + '?r=' + encodeURIComponent(token));

    await expect(page.locator('#view-signin')).toBeVisible();
    await expect(page.locator('#signin-email')).toHaveValue('test-rep@example.com');
  });

  test('Malformed ?r= param is gracefully ignored', async ({ page, baseURL }) => {
    // Any string that isn't valid base64 JSON should not crash the page.
    // The sign-in view should still render with an empty email field.

    const consoleErrors: string[] = [];
    page.on('pageerror', err => consoleErrors.push(err.message));

    await page.goto(resolvePortalURL(baseURL!) + '?r=this-is-not-valid-base64-json');

    await expect(page.locator('#view-signin')).toBeVisible();
    await expect(page.locator('#signin-email')).toHaveValue('');

    // No uncaught page errors — parseRepToken() should have caught and
    // swallowed the JSON.parse/atob exception.
    expect(consoleErrors).toEqual([]);
  });

  test('Clicking Send dispatches an OTP request with the entered email', async ({ portalPage }) => {
    // Intercept the Supabase OTP endpoint so we don't send a real email
    // during tests. The portal now sends the redirect_to as a URL query
    // param, not in the body. We verify the email is in the body.
    let capturedRequest: { email?: string; redirectTo?: string; url?: string } | null = null;

    await portalPage.route('**/auth/v1/otp**', async (route, request) => {
      if (request.method() === 'POST') {
        const url = request.url();
        try {
          const body = JSON.parse(request.postData() || '{}');
          const u = new URL(url);
          capturedRequest = {
            email: body.email,
            redirectTo: u.searchParams.get('redirect_to') || undefined,
            url: url,
          };
        } catch {
          // if we can't parse, capture null
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({}),
        });
      } else {
        await route.continue();
      }
    });

    await portalPage.fill('#signin-email', 'test-rep@example.com');
    await portalPage.click('#btn-send-link');

    // The "check your email" view should appear
    await expect(portalPage.locator('#view-link-sent')).toBeVisible();
    await expect(portalPage.locator('#sent-email')).toHaveText('test-rep@example.com');

    // And the network call should have been made with the right email
    // and a redirect_to URL pointing back at the portal
    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.email).toBe('test-rep@example.com');
    expect(capturedRequest!.redirectTo).toMatch(/portal/);
  });

  test('Existing session causes the signed-in view to render', async ({ seededPortalPage }) => {
    // The seededPortalPage fixture injects a fake session into localStorage
    // before navigation. The portal's getSession() check should find it
    // and show the signed-in view.
    await expect(seededPortalPage.locator('#view-signed-in')).toBeVisible({ timeout: 5_000 });
    await expect(seededPortalPage.locator('#view-signin')).toBeHidden();
    await expect(seededPortalPage.locator('#signed-in-email-inline')).toHaveText('test-rep@arbiter.test');
  });

  test('Sign out returns to the sign-in view', async ({ page, baseURL }) => {
    // Navigate to the portal first (no session yet).
    const url = resolvePortalURL(baseURL!);
    await page.goto(url);

    // Seed a fake session directly via page.evaluate() so it's written
    // once (not on every navigation like addInitScript would do).
    await page.evaluate(() => {
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
          email: 'test-rep@arbiter.test',
        },
      };
      localStorage.setItem(
        'sb-arbiter-portal-auth',
        JSON.stringify(session)
      );
    });

    // Reload so the portal's init() picks up the session and shows
    // the signed-in view.
    await page.reload();
    await expect(page.locator('#view-signed-in')).toBeVisible({ timeout: 5_000 });

    // Intercept the logout endpoint so we don't actually call Supabase.
    await page.route('**/auth/v1/logout**', async route => {
      await route.fulfill({ status: 204, body: '' });
    });

    // Click Sign out. The portal's signOut() handler now deterministically
    // clears localStorage and triggers a navigation via window.location.href.
    // No workaround needed — we can just verify the end state.
    await Promise.all([
      page.waitForLoadState('load'),
      page.locator('#sub-dashboard button.btn-secondary', { hasText: /Sign out/i }).click(),
    ]);

    // After the post-signout reload, session should be gone and the
    // sign-in view should render.
    await expect(page.locator('#view-signin')).toBeVisible();
    await expect(page.locator('#view-signed-in')).toBeHidden();

    // Double-check: localStorage should not have the session key anymore.
    const hasSession = await page.evaluate(() =>
      !!localStorage.getItem('sb-arbiter-portal-auth')
    );
    expect(hasSession).toBe(false);
  });
});
