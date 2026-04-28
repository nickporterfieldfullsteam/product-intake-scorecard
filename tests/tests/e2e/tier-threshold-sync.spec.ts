import { test, expect } from '../helpers/fixtures';
import { openWeightsTab } from '../helpers/auth';

/**
 * Tier threshold sliders + number inputs sync correctly.
 *
 * The Scoring Weights tab has three tier rows (Pursue, Evaluate, Defer).
 * Each row has a range slider and a paired number input. Both must edit
 * the same underlying threshold, and changing one should reflect the
 * other's display.
 *
 * Specifically tested:
 *   1. Changing the number input → underlying state updates → score
 *      tier badge re-evaluates (we use the warning text as a proxy
 *      since it shows current threshold values).
 *   2. Out-of-order thresholds (e.g. Defer > Pursue) → red warning
 *      message appears.
 *
 * Why test this: bidirectional binding between two inputs that share
 * state is the kind of thing that breaks silently when refactored.
 * The warning rule is a separate validation that's easy to drop.
 */
test.describe('Tier threshold sync (qa-3-9 / qa-3-10)', () => {
  test('Number input change updates the threshold and warning text', async ({ authedPage }) => {
    await openWeightsTab(authedPage);

    // Capture current values so we can restore at end of test
    const pursueOriginal = await authedPage.locator('#thresh-num-pursue').inputValue();
    const evaluateOriginal = await authedPage.locator('#thresh-num-evaluate').inputValue();
    const deferOriginal = await authedPage.locator('#thresh-num-defer').inputValue();

    // Change Pursue threshold to a known value via the number input.
    const pursueInput = authedPage.locator('#thresh-num-pursue');
    await pursueInput.fill('80');
    await pursueInput.dispatchEvent('input'); // ensure oninput fires
    await pursueInput.blur();

    // Warning text reflects the new value.
    const warning = authedPage.locator('#thresh-warning');
    await expect(warning).toContainText('Pursue ≥ 80');

    // Restore originals so we don't leave the workspace in a weird state.
    // (persist() fires on each change; this is real DB state.)
    await pursueInput.fill(pursueOriginal);
    await pursueInput.dispatchEvent('input');
    await pursueInput.blur();
    const evaluateInput = authedPage.locator('#thresh-num-evaluate');
    await evaluateInput.fill(evaluateOriginal);
    await evaluateInput.dispatchEvent('input');
    await evaluateInput.blur();
    const deferInput = authedPage.locator('#thresh-num-defer');
    await deferInput.fill(deferOriginal);
    await deferInput.dispatchEvent('input');
    await deferInput.blur();
  });

  test('Out-of-order thresholds trigger a red warning', async ({ authedPage }) => {
    await openWeightsTab(authedPage);

    const pursueOriginal = await authedPage.locator('#thresh-num-pursue').inputValue();
    const evaluateOriginal = await authedPage.locator('#thresh-num-evaluate').inputValue();
    const deferOriginal = await authedPage.locator('#thresh-num-defer').inputValue();

    // Force out-of-order: Pursue lower than Evaluate.
    const pursueInput = authedPage.locator('#thresh-num-pursue');
    await pursueInput.fill('30');
    await pursueInput.dispatchEvent('input');
    await pursueInput.blur();

    const warning = authedPage.locator('#thresh-warning');
    await expect(warning).toContainText(/warning/i);
    await expect(warning).toContainText(/descend/i);

    // Restore
    await pursueInput.fill(pursueOriginal);
    await pursueInput.dispatchEvent('input');
    await pursueInput.blur();
    const evaluateInput = authedPage.locator('#thresh-num-evaluate');
    await evaluateInput.fill(evaluateOriginal);
    await evaluateInput.dispatchEvent('input');
    await evaluateInput.blur();
    const deferInput = authedPage.locator('#thresh-num-defer');
    await deferInput.fill(deferOriginal);
    await deferInput.dispatchEvent('input');
    await deferInput.blur();
  });
});
