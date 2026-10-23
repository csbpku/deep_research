/**
 * Fill the provider settings form in the side panel.
 *
 * The manual model ID field lives inside a collapsed "manual model ID"
 * disclosure, so a plain fill() waits forever for a hidden input. Every
 * script that configures a fake provider opens the disclosure first.
 */
export async function configureProvider(panel, { url, model, key }) {
  await panel.locator('#provider-kind').selectOption('custom', { force: true });
  await panel.locator('#provider-url').fill(url);
  const manual = panel.locator('#manual-model-settings');
  if (await manual.evaluate(node => node.open !== true)) {
    await manual.locator('.MuiAccordionSummary-root').click();
  }
  await panel.locator('#provider-model').fill(model);
  await panel.locator('#provider-key').fill(key);
  await panel.locator('#save-settings').click();
}

/**
 * Start a whole-article translation.
 *
 * When the reader has a selection, the translator defaults to the selected
 * passage instead of the full article, so the image and body coverage
 * assertions below would measure the wrong scope. Choose "整篇" first.
 */
export async function translateWholeArticle(panel) {
  const scopePage = panel.locator('#scope-page');
  if (await scopePage.count() && await scopePage.isVisible()) {
    await scopePage.click();
  }
  await panel.locator('#chat-translate').click();
}
