import { test, expect } from '../helpers/fixtures';
import { seedProjects, cleanTestWorkspace } from '../helpers/supabase';
import { reloadAndWaitForInit } from '../helpers/auth';

/**
 * Dashboard tab (v1.17.0) — PM operations view.
 *
 * The Dashboard is the default landing page after sign-in. It shows
 * attention-focused widgets: blocked/at-risk projects, unreviewed
 * submissions, overdue ETAs, and upcoming revisit dates (14-day window),
 * plus summary metric cards.
 *
 * Strategy: seed known project scenarios directly into the DB, reload,
 * and assert the dashboard widgets render the correct items and counts.
 */
test.describe('Dashboard (v1.17.0)', () => {

  test('Dashboard is the default tab after sign-in', async ({ authedPage }) => {
    await expect(authedPage.locator('#tab-dashboard')).toBeVisible();
    await expect(authedPage.locator('#tab-btn-dashboard')).toHaveClass(/active/);
  });

  test('Empty state: all widgets show empty messages', async ({ authedPage }) => {
    // Fixture cleans workspace, so no projects exist
    await expect(authedPage.locator('#tab-dashboard')).toBeVisible();

    await expect(authedPage.locator('#dash-attention-list')).toContainText('All clear');
    await expect(authedPage.locator('#dash-unreviewed-list')).toContainText('No pending submissions');
    await expect(authedPage.locator('#dash-overdue-list')).toContainText('No overdue ETAs');
    await expect(authedPage.locator('#dash-revisit-list')).toContainText('No revisits');
  });

  test('Metrics cards render correct counts', async ({ authedPage }) => {
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 5);
    const pastEta = pastDate.toISOString().slice(0, 10);

    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 7);
    const futureRevisit = futureDate.toISOString().slice(0, 10);

    await seedProjects([
      { name: 'Blocked project', status: 'Accepted', score: 80, executionStatus: 'Blocked' },
      { name: 'At risk project', status: 'Accepted', score: 75, executionStatus: 'At Risk' },
      { name: 'On track project', status: 'Accepted', score: 90, executionStatus: 'On Track' },
      { name: 'Overdue project', status: 'Accepted', score: 70, executionStatus: 'On Track', executionEta: pastEta },
      { name: 'Unreviewed sub', status: 'Submitted', score: 60 },
      { name: 'Revisit soon', status: 'Deferred', score: 50, revisitDate: futureRevisit },
    ]);

    await reloadAndWaitForInit(authedPage);
    await expect(authedPage.locator('#tab-dashboard')).toBeVisible();

    const metrics = authedPage.locator('#dash-metrics');
    await expect(metrics).toBeVisible();

    // Active projects = 4 (all Accepted)
    const activeCard = metrics.locator('.metric-card', { hasText: 'Active projects' });
    await expect(activeCard).toContainText('4');

    // Unreviewed = 1
    const unreviewedCard = metrics.locator('.metric-card', { hasText: 'Unreviewed' });
    await expect(unreviewedCard).toContainText('1');

    // At risk = 1
    const atRiskCard = metrics.locator('.metric-card', { hasText: 'At risk' });
    await expect(atRiskCard).toContainText('1');

    // Blocked = 1
    const blockedCard = metrics.locator('.metric-card', { hasText: 'Blocked' });
    await expect(blockedCard).toContainText('1');

    // Overdue ETAs = 1
    const overdueCard = metrics.locator('.metric-card', { hasText: 'Overdue ETAs' });
    await expect(overdueCard).toContainText('1');

    // Revisits = 1
    const revisitCard = metrics.locator('.metric-card', { hasText: 'Revisits' });
    await expect(revisitCard).toContainText('1');
  });

  test('Needs attention widget shows blocked and at-risk projects', async ({ authedPage }) => {
    await seedProjects([
      { name: 'Blocked Alpha', status: 'Accepted', score: 80, executionStatus: 'Blocked' },
      { name: 'At Risk Beta', status: 'Accepted', score: 75, executionStatus: 'At Risk' },
      { name: 'On Track Gamma', status: 'Accepted', score: 90, executionStatus: 'On Track' },
    ]);

    await reloadAndWaitForInit(authedPage);
    await expect(authedPage.locator('#tab-dashboard')).toBeVisible();

    const attentionList = authedPage.locator('#dash-attention-list');
    await expect(attentionList).toContainText('Blocked Alpha');
    await expect(attentionList).toContainText('At Risk Beta');
    await expect(attentionList).not.toContainText('On Track Gamma');

    // Count label
    await expect(authedPage.locator('#dash-attention-count')).toContainText('2 projects');
  });

  test('Unreviewed submissions widget shows Submitted projects', async ({ authedPage }) => {
    await seedProjects([
      { name: 'New submission 1', status: 'Submitted', score: 60 },
      { name: 'New submission 2', status: 'Submitted', score: 55 },
      { name: 'Already reviewed', status: 'Under Review', score: 70 },
      { name: 'Already accepted', status: 'Accepted', score: 85 },
    ]);

    await reloadAndWaitForInit(authedPage);
    await expect(authedPage.locator('#tab-dashboard')).toBeVisible();

    const unreviewedList = authedPage.locator('#dash-unreviewed-list');
    await expect(unreviewedList).toContainText('New submission 1');
    await expect(unreviewedList).toContainText('New submission 2');
    await expect(unreviewedList).not.toContainText('Already reviewed');
    await expect(unreviewedList).not.toContainText('Already accepted');

    await expect(authedPage.locator('#dash-unreviewed-count')).toContainText('2 submissions');
  });

  test('Overdue ETAs widget shows accepted projects with past ETA', async ({ authedPage }) => {
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 10);
    const pastEta = pastDate.toISOString().slice(0, 10);

    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 30);
    const futureEta = futureDate.toISOString().slice(0, 10);

    await seedProjects([
      { name: 'Overdue project', status: 'Accepted', score: 70, executionStatus: 'On Track', executionEta: pastEta },
      { name: 'Future project', status: 'Accepted', score: 80, executionStatus: 'On Track', executionEta: futureEta },
      { name: 'No ETA project', status: 'Accepted', score: 75, executionStatus: 'On Track' },
    ]);

    await reloadAndWaitForInit(authedPage);
    await expect(authedPage.locator('#tab-dashboard')).toBeVisible();

    const overdueList = authedPage.locator('#dash-overdue-list');
    await expect(overdueList).toContainText('Overdue project');
    await expect(overdueList).toContainText('days overdue');
    await expect(overdueList).not.toContainText('Future project');
    await expect(overdueList).not.toContainText('No ETA project');

    await expect(authedPage.locator('#dash-overdue-count')).toContainText('1 project');
  });

  test('Upcoming revisits widget shows projects with revisit_date within 14 days', async ({ authedPage }) => {
    const in5Days = new Date();
    in5Days.setDate(in5Days.getDate() + 5);
    const soonRevisit = in5Days.toISOString().slice(0, 10);

    const in30Days = new Date();
    in30Days.setDate(in30Days.getDate() + 30);
    const farRevisit = in30Days.toISOString().slice(0, 10);

    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 5);
    const pastRevisit = pastDate.toISOString().slice(0, 10);

    await seedProjects([
      { name: 'Revisit soon', status: 'Deferred', score: 50, revisitDate: soonRevisit },
      { name: 'Revisit far', status: 'Deferred', score: 45, revisitDate: farRevisit },
      { name: 'Revisit past', status: 'Deferred', score: 40, revisitDate: pastRevisit },
    ]);

    await reloadAndWaitForInit(authedPage);
    await expect(authedPage.locator('#tab-dashboard')).toBeVisible();

    const revisitList = authedPage.locator('#dash-revisit-list');
    await expect(revisitList).toContainText('Revisit soon');
    // Use regex to handle timezone day-count variance (±1 day)
    await expect(revisitList).toContainText(/In \d+ days/);
    await expect(revisitList).not.toContainText('Revisit far');
    await expect(revisitList).not.toContainText('Revisit past');

    await expect(authedPage.locator('#dash-revisit-count')).toContainText('1 project');
  });

  test('Clicking a row in Needs attention navigates to Active Projects', async ({ authedPage }) => {
    await seedProjects([
      { name: 'Blocked nav test', status: 'Accepted', score: 80, executionStatus: 'Blocked' },
    ]);

    await reloadAndWaitForInit(authedPage);
    await expect(authedPage.locator('#tab-dashboard')).toBeVisible();

    await authedPage.locator('#dash-attention-list').locator('div', { hasText: 'Blocked nav test' }).first().click();
    await expect(authedPage.locator('#tab-active-projects')).toBeVisible();
  });

  test('Clicking a row in Unreviewed navigates to Intake', async ({ authedPage }) => {
    await seedProjects([
      { name: 'Unreviewed nav test', status: 'Submitted', score: 60 },
    ]);

    await reloadAndWaitForInit(authedPage);
    await expect(authedPage.locator('#tab-dashboard')).toBeVisible();

    await authedPage.locator('#dash-unreviewed-list').locator('div', { hasText: 'Unreviewed nav test' }).first().click();
    await expect(authedPage.locator('#tab-tracker')).toBeVisible();
  });
});
