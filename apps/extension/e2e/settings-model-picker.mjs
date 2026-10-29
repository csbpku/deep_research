// Exercise the visible MUI picker, including its actual popup, instead of
// mutating the controller's hidden select value.
export async function selectSettingsModel(page, id) {
  const input = page.locator('#provider-model-search');
  await input.fill(id);
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  await page.getByRole('listbox').getByRole('option', { name: new RegExp(`(?:^|\\s)${escaped}$`, 'u') }).click();
}
