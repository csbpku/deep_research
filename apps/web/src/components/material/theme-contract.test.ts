import { describe, expect, it } from 'vitest';
import { designThemeOptions } from '@deep-research/design-system/theme';

describe('shared pointer density', () => {
  for (const mode of ['light', 'dark'] as const) {
    it(`${mode}: tabs and menu items use the same touch target as other controls`, () => {
      const components = designThemeOptions(mode).components;
      for (const name of ['MuiTab', 'MuiTabs', 'MuiMenuItem'] as const) {
        expect(components?.[name]?.styleOverrides?.root).toMatchObject({
          minHeight: '40px',
          '@media (pointer: coarse)': { minHeight: '44px' },
        });
      }
      expect(components?.MuiSelect?.styleOverrides?.select).toMatchObject({
        '@media (pointer: coarse)': { minHeight: '44px', boxSizing: 'border-box' },
      });
    });
  }
});
