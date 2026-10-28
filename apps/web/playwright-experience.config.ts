import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Presentation-only regression: API responses are intercepted in the browser.
// Requires an explicitly started local web server; never seeds a database.
export default defineConfig({
  ...base,
  testMatch: '**/ai-research-experience.spec.ts',
  testIgnore: [],
  globalSetup: undefined,
  webServer: undefined,
});
