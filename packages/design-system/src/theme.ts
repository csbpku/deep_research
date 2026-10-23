import type { CSSProperties, ThemeOptions, TypographyVariantsOptions } from '@mui/material/styles';
import { breakpoints, tokensFor, type DesignMode, type DesignTokens } from './tokens';

declare module '@mui/material/styles' {
  interface TypographyVariants {
    pageTitle: CSSProperties;
    panelTitle: CSSProperties;
    listTitle: CSSProperties;
    fieldTitle: CSSProperties;
    reading: CSSProperties;
    control: CSSProperties;
    metadata: CSSProperties;
  }
  interface TypographyVariantsOptions {
    pageTitle?: CSSProperties;
    panelTitle?: CSSProperties;
    listTitle?: CSSProperties;
    fieldTitle?: CSSProperties;
    reading?: CSSProperties;
    control?: CSSProperties;
    metadata?: CSSProperties;
  }
}
declare module '@mui/material/Typography' {
  interface TypographyPropsVariantOverrides {
    pageTitle: true;
    panelTitle: true;
    listTitle: true;
    fieldTitle: true;
    reading: true;
    control: true;
    metadata: true;
  }
}

/**
 * Shared appearance only: no routing, storage, auth, browser APIs, or bundled React.
 *
 * `variablePrefix` selects the CSS custom-property namespace that carries the
 * runtime colour values. The platform uses `--dr-*`; the Reader uses
 * `--reader-*`. Both read the same token source, so a value is never
 * duplicated — only the prefix that reaches the runtime differs.
 */
export function designThemeOptions(mode: DesignMode = 'light', variablePrefix = 'dr'): ThemeOptions & { typography: TypographyVariantsOptions } {
  const t = tokensFor(mode);
  const appearance = designAppearance(mode, variablePrefix);
  const title = (size: string): CSSProperties => ({ fontSize: size, fontWeight: t['weight-semibold'], lineHeight: t['line-height-heading'] });
  const pageTitle: CSSProperties = {
    ...title(t['type-page-title-mobile']),
    [`@media (min-width:${breakpoints.sm}px)`]: title(t['type-page-title']),
  };
  const focus = { outline: `2px solid ${appearance['color-primary']}`, outlineOffset: '2px' };
  return {
    spacing: Number.parseFloat(t['space-2']),
    breakpoints: { values: breakpoints },
    shape: { borderRadius: Number.parseFloat(t['radius-small']) },
    palette: {
      mode,
      primary: { main: t['color-primary'], light: t['color-primary-container'], dark: t['color-primary-hover'], contrastText: t['color-on-primary'] },
      error: { main: t['color-danger'], contrastText: t['color-surface'] },
      warning: { main: t['color-warning'] },
      success: { main: t['color-success'] },
      info: { main: t['color-evidence'] },
      text: { primary: t['color-text'], secondary: t['color-text-secondary'], disabled: t['color-text-muted'] },
      background: { default: t['color-surface-container'], paper: t['color-surface'] },
      divider: t['color-outline'],
      action: { hover: t['color-surface-container'], selected: t['color-primary-container'], focus: t['color-primary-container-hover'] },
    },
    typography: {
      fontFamily: t['font-family'], fontSize: Number.parseFloat(t['type-body']),
      fontWeightRegular: Number(t['weight-regular']), fontWeightMedium: Number(t['weight-medium']), fontWeightBold: Number(t['weight-bold']),
      h1: pageTitle, h2: title(t['type-title-medium']),
      h3: title(t['type-title-small']), h4: title(t['type-body']),
      h5: title(t['type-body']), h6: title(t['type-label']),
      subtitle1: title(t['type-title-small']), subtitle2: title(t['type-body']),
      body1: { fontSize: t['type-body'], lineHeight: t['line-height-body'] },
      body2: { fontSize: t['type-label'], lineHeight: t['line-height-body'] },
      caption: { fontSize: t['type-caption'], lineHeight: t['line-height-body'] },
      button: { fontSize: t['type-label'], fontWeight: t['weight-medium'], lineHeight: t['line-height-control'], textTransform: 'none' },
      pageTitle, panelTitle: title(t['type-title-medium']), listTitle: title(t['type-title-small']),
      fieldTitle: title(t['type-body']), reading: { fontSize: t['type-reading'], lineHeight: t['line-height-reading'] },
      control: { fontSize: t['type-label'], fontWeight: t['weight-medium'], lineHeight: t['line-height-control'] },
      metadata: { fontSize: t['type-caption'], lineHeight: t['line-height-body'] },
    },
    components: {
      MuiCssBaseline: { styleOverrides: {
        body: { fontSize: appearance['type-body'], lineHeight: appearance['line-height-body'] },
        'button,input,textarea,select': { fontFamily: 'inherit' },
        ':is(button,a,input,textarea,select,[tabindex]):focus-visible': focus,
        '::selection': { background: appearance['color-primary-container'], color: appearance['color-text'] },
      } },
      MuiTypography: { defaultProps: { variantMapping: { pageTitle: 'h1', panelTitle: 'h2', listTitle: 'h3', fieldTitle: 'h4', reading: 'div', control: 'span', metadata: 'span' } } },
      MuiButtonBase: { defaultProps: { disableRipple: true }, styleOverrides: { root: { '&.Mui-focusVisible': focus } } },
      MuiButton: { defaultProps: { disableElevation: true, size: 'small' }, styleOverrides: { root: {
        minWidth: 0, minHeight: appearance['control-height'], borderRadius: appearance['radius-small'], padding: `${appearance['space-2']} ${appearance['space-3']}`, gap: appearance['space-2'], whiteSpace: 'nowrap',
        transition: `background-color ${appearance['motion-fast']}, border-color ${appearance['motion-fast']}`,
        '@media (pointer: coarse)': { minHeight: appearance['touch-target'], minWidth: appearance['touch-target'] },
        '& svg': { width: '16px', height: '16px', flexShrink: 0 },
      } } },
      MuiIconButton: { styleOverrides: { root: { borderRadius: appearance['radius-small'], minWidth: appearance['control-height'], minHeight: appearance['control-height'], '@media (pointer: coarse)': { minWidth: appearance['touch-target'], minHeight: appearance['touch-target'] } } } },
      MuiTextField: { defaultProps: { size: 'small', variant: 'outlined' } },
      MuiOutlinedInput: { styleOverrides: {
        root: { fontSize: appearance['type-body'], minHeight: appearance['control-height'], borderRadius: appearance['radius-small'], backgroundColor: appearance['color-surface-composer'], '& .MuiOutlinedInput-notchedOutline': { borderColor: appearance['color-outline-strong'] }, '@media (pointer: coarse)': { minHeight: appearance['touch-target'] } },
        input: { padding: `${appearance['space-2']} ${appearance['space-3']}`, '&::placeholder': { color: appearance['color-text-muted'], opacity: 1 } },
      } },
      MuiSelect: { styleOverrides: { select: { '@media (pointer: coarse)': { minHeight: appearance['touch-target'], boxSizing: 'border-box', paddingTop: appearance['space-3'], paddingBottom: appearance['space-3'] } } } },
      MuiPaper: { defaultProps: { elevation: 0 }, styleOverrides: { root: { borderRadius: appearance['radius-medium'], backgroundImage: 'none' }, outlined: { borderColor: appearance['color-outline'] } } },
      MuiDialog: { styleOverrides: { paper: { boxShadow: appearance['elevation-2'] } } },
      MuiDrawer: { styleOverrides: { paper: { borderRadius: 0 } } },
      MuiBackdrop: { styleOverrides: { root: { backgroundColor: appearance['color-scrim'] } } },
      MuiMenu: { styleOverrides: { paper: { boxShadow: appearance['elevation-2'], border: `1px solid ${appearance['color-outline']}` } } },
      MuiMenuItem: { styleOverrides: { root: { minHeight: appearance['control-height-row'], fontSize: appearance['type-label'], '@media (pointer: coarse)': { minHeight: appearance['touch-target'] } } } },
      MuiChip: { styleOverrides: { root: { height: appearance['chip-height'], borderRadius: appearance['radius-xs'], fontSize: appearance['type-caption'] } } },
      MuiTabs: { styleOverrides: { root: { minHeight: appearance['control-height-row'], '@media (pointer: coarse)': { minHeight: appearance['touch-target'] } } } },
      MuiTab: { styleOverrides: { root: { minHeight: appearance['control-height-row'], textTransform: 'none', fontSize: appearance['type-label'], fontWeight: appearance['weight-medium'], '@media (pointer: coarse)': { minHeight: appearance['touch-target'] } } } },
      MuiTooltip: { styleOverrides: { tooltip: { fontSize: appearance['type-caption'], backgroundColor: appearance['color-inverse-surface'], color: appearance['color-inverse-text'] } } },
    },
  };
}

/**
 * The runtime token map for one surface.
 *
 * Colour and elevation resolve to the CSS custom properties that the
 * generated stylesheet owns, so a scheme switch repaints without rebuilding
 * the theme. Sizing, spacing and typography stay literal: they do not change
 * between schemes.
 */
export function designAppearance(mode: DesignMode = 'light', variablePrefix = 'dr'): DesignTokens {
  const t = tokensFor(mode);
  return Object.fromEntries(
    Object.entries(t).map(([key, value]) => [
      key,
      key.startsWith('color-') || key.startsWith('elevation-')
        ? `var(--${variablePrefix}-${key}, ${value})`
        : value,
    ]),
  ) as DesignTokens;
}
