import { describe, expect, it } from 'vitest';
import { createTheme } from '@mui/material/styles';
import { designThemeOptions } from '@deep-research/design-system/theme';
import { breakpoints, space, tokens } from '@deep-research/design-system';

describe('shared Material design contract', () => {
  it('uses an eight pixel spacing base and explicit named intermediate values', () => {
    const theme = createTheme(designThemeOptions());
    expect(theme.spacing(3)).toBe('24px');
    expect(space.md).toBe('12px');
    expect(theme.breakpoints.values).toEqual(breakpoints);
  });
  it('keeps the typography hierarchy and reading scale identical across modes', () => {
    const light = designThemeOptions('light');
    const dark = designThemeOptions('dark');
    expect(dark.typography).toEqual(light.typography);
    expect(light.typography.pageTitle?.fontSize).toBe(tokens['type-page-title-mobile']);
    expect(light.typography.panelTitle?.fontSize).toBe(tokens['type-title-medium']);
    expect(light.typography.reading).toEqual({ fontSize: tokens['type-reading'], lineHeight: tokens['line-height-reading'] });
    expect(light.typography.panelTitle?.lineHeight).toBe(tokens['line-height-heading']);
    expect(light.typography.metadata?.fontSize).toBe('12px');
  });
  it('provides distinct dark surfaces rather than a filter or inherited light palette', () => {
    const light = createTheme(designThemeOptions('light'));
    const dark = createTheme(designThemeOptions('dark'));
    expect(dark.palette.mode).toBe('dark');
    expect(dark.palette.background.paper).not.toEqual(light.palette.background.paper);
    expect(dark.palette.text.primary).not.toEqual(light.palette.text.primary);
  });
});
