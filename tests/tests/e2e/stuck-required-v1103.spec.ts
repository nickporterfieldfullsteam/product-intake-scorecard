import { test, expect } from '../helpers/fixtures';
import { openEditorTab } from '../helpers/auth';

/**
 * v1.10.3 regression test: stuck "required" toggle on detail fields.
 *
 * The bug: in renderDetailEditor, three render conditions confused
 * f.required (user-toggleable) with f.locked (immutable system flag):
 *   - Remove button hidden when f.required (should be f.locked)
 *   - Type dropdown disabled when f.required (should be f.locked)
 *   - Required checkbox HIDDEN when f.required (should be f.locked)
 *
 * The third one was the user-visible problem: once you toggled a
 * custom field "required", the checkbox itself disappeared and
 * was replaced with "This field is locked as required." — so
 * there was no way to ever toggle it back off.
 *
 * Fix: gate all three on f.locked (the immutable system flag) so
 * user-added fields stay freely editable in all dimensions.
 *
 * This test verifies:
 *   1. Adding a custom detail field works
 *   2. Toggling it required ON keeps the checkbox visible
 *   3. Toggling it OFF works (un-checks)
 *   4. The Remove button is still available throughout
 *   5. Cleanup: remove the field at the end so we don't pollute
 *      workspace_config.detail_fields permanently
 */
test.describe('v1.10.3 stuck-required regression', () => {
  test('Custom detail field required toggle stays bidirectional', async ({ authedPage }) => {
    await openEditorTab(authedPage);

    // Click "+ Add detail field" — this creates a field, persists it,
    // and auto-expands the new card. The card body becomes visible
    // after a 50ms setTimeout in addDetailField.
    await authedPage.locator('button', { hasText: /\+ Add detail field/i }).click();
    await authedPage.waitForTimeout(150); // wait past the 50ms toggleDetailCard delay

    // Locate the most recently added card (the new field). Detail field
    // cards are .criterion-card with id dfcard-{id}. Newest is appended
    // last in the list.
    const cards = authedPage.locator('.criterion-card[id^="dfcard-"]');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
    const newCard = cards.nth(count - 1);

    // The required checkbox starts unchecked (default for new fields).
    const checkbox = newCard.locator('input[type="checkbox"][id^="req-"]');
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();

    // Remove button should also be visible (it's a custom, non-locked field).
    const removeBtn = newCard.locator('button', { hasText: /^Remove$/i });
    await expect(removeBtn).toBeVisible();

    // Toggle required ON. After the change, the checkbox should STILL
    // be visible — that's the regression we're guarding against.
    await checkbox.check();
    // Re-find the checkbox in case of re-render. The card itself has the
    // same id, so it persists; the checkbox inside should also persist
    // since we no longer re-render on key='required'.
    await expect(checkbox).toBeVisible();
    await expect(checkbox).toBeChecked();

    // The Remove button should ALSO still be visible — the second part
    // of the bug, gating Remove on f.required instead of f.locked.
    await expect(removeBtn).toBeVisible();

    // Toggle required OFF. Checkbox should become unchecked.
    await checkbox.uncheck();
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();

    // CLEANUP: remove the test field so workspace_config doesn't fill up.
    // Native confirm() needs a dialog handler. removeDetailField calls
    // confirm() before deleting.
    authedPage.once('dialog', async dialog => { await dialog.accept(); });
    await removeBtn.click();
    // Card should be gone after the persist + re-render.
    await expect(newCard).toHaveCount(0, { timeout: 3_000 });
  });
});
