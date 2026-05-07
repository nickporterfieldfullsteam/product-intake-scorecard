import { test, expect } from '../helpers/fixtures';
import { countProjects } from '../helpers/supabase';
import { openSettingsTab, reloadAndWaitForInit } from '../helpers/auth';

/**
 * v1.9.4 regression test.
 *
 * The bug: after hydrating from Supabase, every sample project rendered
 * with a spurious "↑ <score>" indicator. Root cause: the render check
 * was `p.previousScore !== undefined`, but Supabase writes null (not
 * undefined) for never-re-scored projects, so the check passed. Then
 * `p.score > p.previousScore` coerced null to 0 and the arrow showed
 * the full score as a delta.
 *
 * Fix: use `p.previousScore != null` which also excludes null.
 *
 * This test verifies no trend indicators appear on projects that have
 * never been re-scored, specifically after a reload (the failure mode
 * was reload-only because the in-memory sample objects legitimately
 * had `previousScore === undefined` until the DB round-trip normalized
 * them to null).
 */
test.describe('v1.9.4 phantom score-delta regression', () => {
  test('fresh samples show no up/down trend arrows after reload', async ({ authedPage }) => {
    expect(await countProjects()).toBe(0);

    // Generate the 13 sample projects
    await openSettingsTab(authedPage);
    await authedPage.locator('#btn-generate-samples').click();

    // Wait for all writes to land in Supabase
    await expect.poll(
      async () => await countProjects(),
      { timeout: 15_000, intervals: [500, 1000, 2000] }
    ).toBe(13);

    // Hard reload — this is the critical step; the bug only manifested
    // after hydrating from the DB (null previous_score).
    await reloadAndWaitForInit(authedPage);
    await authedPage.locator('#tab-btn-tracker').click();
    await expect(authedPage.locator('#tab-tracker')).toBeVisible();

    // Wait for at least one project row to render in the list view
    await expect.poll(
      async () => authedPage.locator('#projects-list > *').count()
    ).toBeGreaterThan(0);

    // --- List view assertion ---
    // The list view's project meta line is `<div class="proj-meta">...</div>`.
    // A trend arrow shows up inline inside that div. Sample projects have
    // never been re-scored, so no ↑ or ↓ should appear anywhere on the
    // tracker page. We check the page text since the arrows are plain
    // unicode characters in any rendered state.
    const listText = await authedPage.locator('#projects-list').innerText();
    expect(listText).not.toContain('↑');
    expect(listText).not.toContain('↓');

    // --- Kanban view assertion ---
    // Switch to the board view and confirm the same invariant there.
    await authedPage.locator('#view-btn-board').click();
    await expect(authedPage.locator('.kanban-board')).toBeVisible();
    const kanbanText = await authedPage.locator('.kanban-board').innerText();
    expect(kanbanText).not.toContain('↑');
    expect(kanbanText).not.toContain('↓');
  });
});
