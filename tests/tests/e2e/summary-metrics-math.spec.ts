import { test, expect } from '../helpers/fixtures';
import { seedProjects } from '../helpers/supabase';

/**
 * Summary metrics math correctness (qa-2-14).
 *
 * The Tracker tab's summary metrics row computes Total, Avg score,
 * Acceptance rate (among decided projects), and Overdue revisits
 * (Deferred projects with a past revisit_date). These are core
 * dashboard signals — if the math is wrong, you'd misread your
 * pipeline.
 *
 * This test seeds a known scenario directly into the DB (bypassing
 * the UI) and asserts the rendered metric values match.
 *
 * Scenario (5 projects):
 *   1. Score 90, Accepted
 *   2. Score 80, Accepted
 *   3. Score 70, Passed
 *   4. Score 60, Deferred with revisit_date in the past (overdue)
 *   5. Score 50, Submitted
 *
 * Expected metrics:
 *   Total = 5
 *   Avg score = (90+80+70+60+50)/5 = 70
 *   Decided = 4 (Accepted+Accepted+Passed+Deferred — Submitted excluded)
 *   Accepted = 2
 *   Acceptance rate = 2/4 = 50%
 *   Overdue = 1 (the Deferred with past revisit)
 */
test.describe('Summary metrics math (qa-2-14)', () => {
  test('Metrics reflect seeded projects correctly', async ({ authedPage }) => {
    // Build a past date for the Deferred-overdue case (30 days ago, ISO format)
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 30);
    const pastDateIso = pastDate.toISOString().slice(0, 10);

    await seedProjects([
      { name: 'Metrics Test 1 (90 Acc)', status: 'Accepted', score: 90 },
      { name: 'Metrics Test 2 (80 Acc)', status: 'Accepted', score: 80 },
      { name: 'Metrics Test 3 (70 Pass)', status: 'Passed', score: 70 },
      { name: 'Metrics Test 4 (60 Def overdue)', status: 'Deferred', score: 60, revisitDate: pastDateIso },
      { name: 'Metrics Test 5 (50 Sub)', status: 'Submitted', score: 50 },
    ]);

    // Hard reload so the app picks up the seeded projects from DB
    await authedPage.reload();
    await authedPage.locator('#tab-btn-tracker').click();

    // Wait for the summary-metrics container to render
    const metrics = authedPage.locator('#summary-metrics');
    await expect(metrics).toBeVisible();
    // Wait for the metrics to actually populate (otherwise we race the render)
    await expect(metrics.locator('.metric-card').first()).toBeVisible();

    // Total
    const totalCard = metrics.locator('.metric-card').filter({ hasText: 'Total projects' });
    await expect(totalCard.locator('.metric-value')).toHaveText('5');

    // Avg score
    const avgCard = metrics.locator('.metric-card').filter({ hasText: 'Avg score' });
    await expect(avgCard.locator('.metric-value')).toHaveText('70');

    // Acceptance rate: 2 accepted out of 4 decided = 50%
    const accCard = metrics.locator('.metric-card').filter({ hasText: 'Acceptance rate' });
    await expect(accCard.locator('.metric-value')).toHaveText('50%');
    await expect(accCard).toContainText('4 decided');

    // Overdue revisits: 1 overdue, 0 upcoming-this-week.
    // The card has class "alert" when overdue > 0, value = the overdue count.
    const overdueCard = metrics.locator('.metric-card').filter({ hasText: 'Overdue revisits' });
    await expect(overdueCard.locator('.metric-value')).toHaveText('1');
  });
});
