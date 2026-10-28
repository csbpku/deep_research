import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Presentation-only regression: API responses are intercepted in the browser.
// Requires an explicitly started local web server; never seeds a database.
export default defineConfig({
  ...base,
  testMatch: ['**/ai-research-experience.spec.ts', '**/ai-research-uncertain.spec.ts', '**/ai-research-slides-experience.spec.ts', '**/ai-research-source-recovery.spec.ts'],
  testIgnore: [],
  globalSetup: undefined,
  webServer: undefined,
});
