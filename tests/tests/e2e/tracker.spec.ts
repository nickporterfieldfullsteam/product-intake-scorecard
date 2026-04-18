import { test, expect } from '../helpers/fixtures';
import { createProject } from '../helpers/scorecard';
import { countProjects } from '../helpers/supabase';

test.describe('Tracker', () => {
  test('empty state renders when no projects exist', async ({ authedPage }) => {
    expect(await countProjects()).toBe(0);
    await authedPage.locator('#tab-btn-tracker').click();
    await expect(authedPage.locator('#projects-list')).toBeVisible();
    // Should show some empty-state text
    const text = await authedPage.locator('#projects-list').innerText();
    expect(text.length).toBeGreaterThan(0);
  });

  test('projects appear in the list after creation', async ({ authedPage }) => {
    await createProject(authedPage, {
      name: 'Tracker Appears Test',
      customer: 'Cust A',
      submitter: 'Sub A',
      email: 'a@test.com',
    });
    await authedPage.locator('#tab-btn-tracker').click();
    await expect(authedPage.locator('#projects-list')).toContainText('Tracker Appears Test');
  });

  test('search filters the project list', async ({ authedPage }) => {
    await createProject(authedPage, {
      name: 'Findable Alpha',
      customer: 'CustA', submitter: 'SubA', email: 'a@t.com',
    });
    await createProject(authedPage, {
      name: 'Hidden Beta',
      customer: 'CustB', submitter: 'SubB', email: 'b@t.com',
    });

    await authedPage.locator('#tab-btn-tracker').click();
    const list = authedPage.locator('#projects-list');
    await expect(list).toContainText('Findable Alpha');
    await expect(list).toContainText('Hidden Beta');

    await authedPage.fill('#project-search', 'Findable');
    await authedPage.waitForTimeout(200);
    await expect(list).toContainText('Findable Alpha');
    await expect(list).not.toContainText('Hidden Beta');

    await authedPage.fill('#project-search', '');
    await expect(list).toContainText('Hidden Beta');
  });

  test('switching to board view renders kanban', async ({ authedPage }) => {
    await createProject(authedPage, {
      name: 'Board View Project',
      customer: 'Board Cust', submitter: 'Board Sub', email: 'board@t.com',
    });
    await authedPage.locator('#tab-btn-tracker').click();

    // The view toggle buttons live at the top of the tracker.
    // Default is list; click #view-btn-board to switch to kanban.
    await authedPage.locator('#view-btn-board').click();
    await expect(authedPage.locator('#kanban-board')).toBeVisible();

    // Switch back to list and confirm kanban is hidden again
    await authedPage.locator('#view-btn-list').click();
    await expect(authedPage.locator('#kanban-board')).toBeHidden();
  });

  test('summary metrics reflect project count', async ({ authedPage }) => {
    // Create 3 projects
    for (let i = 1; i <= 3; i++) {
      await createProject(authedPage, {
        name: `Metrics Project ${i}`,
        customer: `Cust${i}`, submitter: `Sub${i}`, email: `m${i}@t.com`,
      });
    }
    await authedPage.locator('#tab-btn-tracker').click();
    const metrics = authedPage.locator('#summary-metrics');
    await expect(metrics).toBeVisible();
    const text = await metrics.innerText();
    // Should mention 3 somewhere (total count)
    expect(text).toMatch(/\b3\b/);
  });
});
