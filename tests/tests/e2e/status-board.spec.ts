import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import * as path from 'path';

/**
 * Status board (v1.17.0) — shareable public page.
 *
 * The status board at /status/ is a standalone page that requires no login.
 * Access is controlled by a token in the URL query param, validated via
 * the validate_status_board_token SECURITY DEFINER RPC.
 *
 * Strategy: use the admin Supabase client to set a known token on the
 * test workspace's workspace_config, seed projects, then navigate to
 * the status board with that token. No authedPage fixture needed since
 * the page doesn't require auth.
 */

const TEST_TOKEN = 'playwright-test-token-' + Date.now();

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY!;
  return createClient(url, key);
}

async function getAuthedClient() {
  const client = getSupabaseClient();
  const { data: { session } } = await client.auth.getSession();
  if (session) return client;
  const { error } = await client.auth.signInWithPassword({
    email: process.env.TEST_USER_EMAIL!,
    password: process.env.TEST_USER_PASSWORD!,
  });
  if (error) throw new Error('Sign-in failed: ' + error.message);
  return client;
}

function getStatusBoardURL(): string {
  const target = process.env.TEST_LIVE_URL || process.env.TEST_SERVER_URL || '';
  if (target) {
    const base = target.endsWith('/') ? target : target + '/';
    return base + 'status/index.html';
  }
  // Local file — __dirname is tests/tests/e2e, so go up 3 levels to repo root
  const absPath = path.resolve(__dirname, '..', '..', '..', 'status', 'index.html');
  return 'file://' + absPath.split(path.sep).join('/');
}

test.describe('Status board (v1.17.0)', () => {
  const workspaceId = process.env.TEST_WORKSPACE_ID!;

  test.beforeAll(async () => {
    const sb = await getAuthedClient();
    // Set a known token
    await sb.from('workspace_config').update({ status_board_token: TEST_TOKEN }).eq('workspace_id', workspaceId);
    // Clean and seed projects
    await sb.from('projects').delete().eq('workspace_id', workspaceId);
    await sb.from('projects').insert([
      {
        workspace_id: workspaceId, name: 'Board Test Alpha', status: 'Accepted', score: 80, tier: 'pursue',
        criteria_vals: {}, criteria_snapshot: {}, locked_vals: {}, detail_vals: {},
        project_type: '', is_sample: false,
        execution_sponsor_group: 'Product', execution_platform: 'Integrapark',
        execution_priority: 'High', execution_lifecycle: 'Development',
        execution_status: 'On Track', execution_eta: '2026-07-01',
        execution_owners: ['Alice Smith', 'Bob Jones'],
      },
      {
        workspace_id: workspaceId, name: 'Board Test Beta', status: 'Accepted', score: 70, tier: 'evaluate',
        criteria_vals: {}, criteria_snapshot: {}, locked_vals: {}, detail_vals: {},
        project_type: '', is_sample: false,
        execution_sponsor_group: 'Support', execution_platform: 'Zephire',
        execution_priority: 'Normal', execution_lifecycle: 'Planning',
        execution_status: 'Blocked', execution_owners: ['Charlie Dean'],
      },
      {
        workspace_id: workspaceId, name: 'Board Test Gamma', status: 'Accepted', score: 90, tier: 'pursue',
        criteria_vals: {}, criteria_snapshot: {}, locked_vals: {}, detail_vals: {},
        project_type: '', is_sample: false,
        execution_lifecycle: 'Testing', execution_status: 'On Track',
      },
    ]);
  });

  test.afterAll(async () => {
    const sb = await getAuthedClient();
    await sb.from('projects').delete().eq('workspace_id', workspaceId);
    await sb.from('workspace_config').update({ status_board_token: '' }).eq('workspace_id', workspaceId);
  });

  test('Invalid token shows error message', async ({ page }) => {
    const url = getStatusBoardURL() + '?token=definitely-not-valid';
    await page.goto(url);
    await expect(page.locator('#invalid')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#invalid')).toContainText('Invalid or expired link');
    await expect(page.locator('#app')).toBeHidden();
  });

  test('Missing token shows error message', async ({ page }) => {
    await page.goto(getStatusBoardURL());
    await expect(page.locator('#invalid')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#app')).toBeHidden();
  });

  test('Valid token renders the board with seeded projects', async ({ page }) => {
    const url = getStatusBoardURL() + '?token=' + TEST_TOKEN;
    await page.goto(url);
    await expect(page.locator('#app')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#loading')).toBeHidden();

    // Board should show 3 projects
    await expect(page.locator('#board-count')).toContainText('3 active projects');

    // Project names visible
    await expect(page.locator('#board')).toContainText('Board Test Alpha');
    await expect(page.locator('#board')).toContainText('Board Test Beta');
    await expect(page.locator('#board')).toContainText('Board Test Gamma');
  });

  test('Board groups projects by lifecycle stage', async ({ page }) => {
    const url = getStatusBoardURL() + '?token=' + TEST_TOKEN;
    await page.goto(url);
    await expect(page.locator('#app')).toBeVisible({ timeout: 10_000 });

    const board = page.locator('#board');

    // Seeded projects span 3 stages: Planning, Development, Testing
    // Each stage gets its own column
    await expect(board.locator('.board-col')).toHaveCount(3);

    // Planning column has Beta
    await expect(board).toContainText('Planning');
    await expect(board.locator('.board-col').filter({ hasText: 'Planning' })).toContainText('Board Test Beta');

    // Development column has Alpha
    await expect(board).toContainText('Development');
    await expect(board.locator('.board-col').filter({ hasText: 'Development' })).toContainText('Board Test Alpha');

    // Testing column has Gamma
    await expect(board).toContainText('Testing');
    await expect(board.locator('.board-col').filter({ hasText: 'Testing' })).toContainText('Board Test Gamma');
  });

  test('Cards show execution fields, not scores', async ({ page }) => {
    const url = getStatusBoardURL() + '?token=' + TEST_TOKEN;
    await page.goto(url);
    await expect(page.locator('#app')).toBeVisible({ timeout: 10_000 });

    const board = page.locator('#board');

    // Alpha card should show execution details
    await expect(board).toContainText('Product');
    await expect(board).toContainText('Integrapark');
    await expect(board).toContainText('High');
    await expect(board).toContainText('On Track');
    await expect(board).toContainText('Jul 1');

    // Owner avatars should be present
    const avatars = board.locator('.avatar');
    await expect(avatars.first()).toBeVisible();

    // Scores should NOT appear anywhere on the page
    const pageText = await page.locator('body').innerText();
    expect(pageText).not.toContain('Score');
    expect(pageText).not.toContain('pursue');
    expect(pageText).not.toContain('evaluate');
  });

  test('Filters narrow the displayed projects', async ({ page }) => {
    const url = getStatusBoardURL() + '?token=' + TEST_TOKEN;
    await page.goto(url);
    await expect(page.locator('#app')).toBeVisible({ timeout: 10_000 });

    // Filter by platform Integrapark → only Alpha
    await page.selectOption('#filter-platform', 'Integrapark');
    await expect(page.locator('#board-count')).toContainText('1 active project');
    await expect(page.locator('#board')).toContainText('Board Test Alpha');
    await expect(page.locator('#board')).not.toContainText('Board Test Beta');

    // Reset filter
    await page.selectOption('#filter-platform', '');
    await expect(page.locator('#board-count')).toContainText('3 active projects');

    // Filter by status Blocked → only Beta
    await page.selectOption('#filter-status', 'Blocked');
    await expect(page.locator('#board-count')).toContainText('1 active project');
    await expect(page.locator('#board')).toContainText('Board Test Beta');
    await expect(page.locator('#board')).not.toContainText('Board Test Alpha');
  });
});
