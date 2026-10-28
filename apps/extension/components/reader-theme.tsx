import React from 'react';
import CssBaseline from '@mui/material/CssBaseline';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import token from '@deep-research/design-system/tokens.json';
import { designAppearance, designThemeOptions } from '@deep-research/design-system/theme';

// The Reader reads the same generated stylesheet the platform uses, only
// under the `--reader-*` prefix. Colour therefore comes from one source.
const appearance = designAppearance('light', 'reader');
const text = appearance['color-text'];
const muted = appearance['color-text-muted'];
const primary = appearance['color-primary'];
const outline = appearance['color-outline'];
const fieldOutline = appearance['color-outline-strong'];
const radius = token['radius-small'];
const focus = { outline: `2px solid ${primary}`, outlineOffset: '2px' };
const caption = { fontSize: token['type-caption'], lineHeight: token['line-height-body'], color: muted };

/**
 * All extension control skins live here. Page CSS owns layout only.
 *
 * The Reader renders one scheme. The palette comes from the shared token
 * file, and the CSS-variable bridge in `designAppearance` points at the
 * generated `--reader-*` custom properties. The panel, the history page and
 * the in-page controls therefore read the same palette the platform uses.
 */
const options = designThemeOptions('light', 'reader');

// No `cssVariables` and no `colorSchemes`: MUI stays on its plain theme path,
// so the provider never writes a `light`/`dark` class onto <html>. One
// scheme means there is nothing to switch and nothing to disagree about.
export const readerTheme = createTheme({
  ...options,
  // Reader is a compact panel; its top heading uses the shared panel scale.
  typography: { ...options.typography, h1: options.typography?.panelTitle },
  components: {
    MuiCssBaseline: { styleOverrides: {
      body: { color: text, background: appearance['color-surface'], fontFamily: token['font-family'], fontSize: token['type-body'], lineHeight: token['line-height-body'] },
      'h1,h2': { margin: 0, fontSize: token['type-title-large'], fontWeight: token['weight-semibold'], lineHeight: token['line-height-heading'] },
      'h3,h4': { margin: 0, fontSize: token['type-title-small'], fontWeight: token['weight-semibold'], lineHeight: token['line-height-heading'] },
      p: { margin: 0 }, 'button,input,textarea,select': { fontFamily: 'inherit' },
      'a': { color: primary, textUnderlineOffset: '3px' },
      '.small,.eyebrow,.settings-kicker,.tool-help,.source,.discussion-source-main,.conversation-message-header,.composer-scope-label,.discussion-scope-label,.image-preview-meta,.provider-feedback,.mode-guidance,.progress-line,.response-more-summary,.history-summary,.history-card-source,.history-detail-meta': caption,
      '.eyebrow,.settings-kicker': { fontWeight: token['weight-semibold'] },
      '.field > label,.card-title label,.composer-model-menu > label': { display: 'block', marginBottom: token['space-2'], color: appearance['color-text-secondary'], fontSize: token['type-label'], fontWeight: token['weight-medium'] },
      '.settings-card': { borderTop: `1px solid ${outline}` },
      '.MuiFormControl-root:has(input.hidden)': { display: 'none' },
      '.provider-picker-group h4': { ...caption, fontWeight: token['weight-semibold'] },
      '.reader-composer-field textarea': { fontSize: token['type-reading'], lineHeight: token['line-height-reading'] },
      '.conversation-message-body,.history-detail-message-body': { color: text, fontSize: token['type-reading'], lineHeight: token['line-height-reading'] },
      '.pending-turn .conversation-message.user': { padding: '12px', backgroundColor: appearance['color-surface-container'], borderRadius: '12px 12px 4px 12px' },
      '.pending-turn .conversation-message-header': { marginBottom: '8px' },
      '.mark': { borderRadius: radius, background: text, color: appearance['color-inverse-text'], fontSize: token['type-title-small'], fontWeight: token['weight-semibold'] },
      '.wordmark > span:last-child': { fontSize: token['type-title-small'], fontWeight: token['weight-semibold'] },
      '.masthead': { borderBottom: `1px solid ${outline}` },
      '.discussion-source-card': { borderBottom: `1px solid ${outline}`, backgroundColor: appearance['color-surface-container'] },
      '.discussion-source-main strong': { color: text, fontSize: token['type-label'], fontWeight: token['weight-medium'], lineHeight: token['line-height-control'] },
      '.history-tab strong': { fontSize: token['type-caption'], fontVariantNumeric: 'tabular-nums' },
      '.mode-option-content strong': { fontSize: token['type-body'], fontWeight: token['weight-semibold'], lineHeight: token['line-height-control'], color: text },
      '.mode-option-content > span': caption,
      '.mode-option-check,.provider-picker-check': { color: primary },
      '.provider-picker-selected strong,.provider-picker-option strong': { fontSize: token['type-label'], fontWeight: token['weight-semibold'], lineHeight: token['line-height-control'] },
      '.provider-picker-selected > span,.provider-picker-option small,.provider-picker-group h4': caption,
      '.provider-logo-dark': { padding: '3px', borderRadius: '4px', background: text },
      '.provider-feedback[data-state="error"]': { color: appearance['color-danger'] },
      '.provider-feedback[data-state="ready"],.provider-feedback[data-state="verified"]': { color: appearance['color-success'] },
      '.page-notice-container': { background: appearance['color-primary-container'], borderRadius: radius },
      '.page-notice-container .MuiAlert-root': { p: 0, bgcolor: 'transparent' },
      '.connection-badge': { ...caption, padding: '4px 8px', borderRadius: radius, background: appearance['color-surface-container'] },
      '.connection-badge.connected': { color: appearance['color-success'], background: appearance['color-success-container'] },
      '.composer-resize span': { borderRadius: '4px', background: fieldOutline },
      '.composer-resize:hover span,.composer-resize:focus-visible span': { background: primary },
      '.keyboard-navigation .chat-composer:has(textarea:focus-visible)': focus,
      '#settings-notice[data-result="success"]': { backgroundColor: appearance['color-success-container'], color: appearance['color-success'] },
      '.dismiss-notice': { color: muted },
      '.history-toast': { ...caption, background: appearance['color-surface-raised'], border: `1px solid ${outline}`, borderRadius: radius, boxShadow: 'var(--reader-elevation-2)' },
      '.track': { height: '4px', borderRadius: '4px', background: appearance['color-surface-container'] },
      '.bar': { background: primary }, '.bar.image': { background: appearance['color-success'] },
      '.response-section': { border: `1px solid ${outline}`, borderRadius: token['radius-medium'], background: appearance['color-surface-container'], color: text, fontSize: token['type-body'], lineHeight: token['line-height-reading'] },
      '.response-section-label': { fontSize: token['type-label'], fontWeight: token['weight-semibold'], color: primary },
      '.response-section[data-answer-section="background"] .response-section-label': { color: appearance['color-background-context'] },
      '.response-section[data-answer-section="inference"] .response-section-label': { color: appearance['color-inference'] },
      '.response-section[data-answer-section="limitations"] .response-section-label': { color: appearance['color-limitations'] },
      '.response-section p,.response-section li': { fontSize: token['type-body'], lineHeight: token['line-height-reading'] },
      ':is(button,a,[tabindex]):focus-visible': focus,
      '::selection': { background: appearance['color-primary-container'], color: text },
    } },
    MuiButtonBase: { defaultProps: { disableRipple: true }, styleOverrides: { root: {
      fontFamily: token['font-family'], '&.Mui-focusVisible': focus,
      '&[data-reader-control="navigation"]': { minWidth: '44px', minHeight: '44px', padding: '6px 8px', gap: '6px', borderBottom: '2px solid transparent', color: muted, fontSize: token['type-label'], whiteSpace: 'nowrap',
        '&:hover': { bgcolor: 'action.hover' }, '&[aria-pressed="true"],&[aria-current="page"]': { color: primary, borderBottomColor: primary, fontWeight: token['weight-semibold'] } },
    } } },
    MuiButton: { defaultProps: { disableElevation: true, disableRipple: true, size: 'small' }, styleOverrides: { root: {
      minWidth: 0, minHeight: token['control-height'], padding: `${token['space-2']} ${token['space-3']}`, borderRadius: radius, fontSize: token['type-label'], fontWeight: token['weight-medium'], lineHeight: token['line-height-control'], textTransform: 'none',
      transition: `background-color ${token['motion-fast']}, color ${token['motion-fast']}, border-color ${token['motion-fast']}`,
      '&:disabled': { opacity: .45, pointerEvents: 'none' }, '&.Mui-disabled:not(:disabled)': { pointerEvents: 'auto', opacity: 1 },
      '&[data-reader-control="tonal"]': { color: primary, background: appearance['color-primary-container'], '&:hover': { background: appearance['color-primary-container-hover'] } },
      '&[data-reader-control="mode"]': { position: 'relative', justifyContent: 'flex-start', alignItems: 'flex-start', minHeight: '88px', padding: token['space-3'], textAlign: 'left', whiteSpace: 'normal', width: '100%', color: text,
        '&[aria-pressed="true"]': { borderColor: primary, background: appearance['color-primary-container'], '& .mode-option-check': { visibility: 'visible' } } },
      '&[data-reader-control="scope"]': { padding: '4px 8px', minHeight: '32px', color: muted, '&[aria-pressed="true"]': { color: primary, background: appearance['color-primary-container'] } },
      '&[data-reader-control="icon"]': { width: '40px', height: '40px', minHeight: '40px', padding: 0, flexShrink: 0 },
      '&[data-reader-control="compact"]': { minHeight: '32px', padding: '4px 8px' },
      '&[data-reader-control="provider"]': { display: 'flex', justifyContent: 'flex-start', textAlign: 'left', gap: '12px', width: '100%', minHeight: '64px', padding: '12px', border: `1px solid ${fieldOutline}`, color: text,
        '&[aria-selected="true"],&[aria-expanded="true"]': { borderColor: primary, background: appearance['color-primary-container'], '& .provider-picker-check': { visibility: 'visible' } } },
      '&[data-reader-control="followup"]': { justifyContent: 'space-between', gap: '12px', minHeight: '44px', padding: '8px', textAlign: 'left', whiteSpace: 'normal', color: text,
        '& > span:first-of-type': { minWidth: 0, overflowWrap: 'anywhere' },
        '& .MuiButton-endIcon': { flexShrink: 0, margin: 0, color: primary },
        '&:hover': { backgroundColor: appearance['color-surface-container'] } },
      '&[data-reader-control="model"]': { marginLeft: 'auto', minHeight: '36px', padding: '4px 8px', gap: '8px',
        '& #composer-model-label': { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        '& .MuiButton-endIcon': { display: 'flex', flexShrink: 0, margin: 0, transition: `transform ${token['motion-fast']}` },
        '& .MuiButton-endIcon > svg': { fontSize: '20px', width: '20px', height: '20px' },
        '&[aria-expanded="true"] .MuiButton-endIcon': { transform: 'rotate(180deg)' },
        '&:disabled': { color: appearance['color-text-muted'], opacity: 1 },
        '&:disabled .MuiButton-endIcon': { display: 'none' } },
    }, startIcon: { marginLeft: 0, marginRight: '8px' } }, variants: [
      { props: { variant: 'outlined' }, style: { borderColor: fieldOutline, color: appearance['color-text-secondary'], '&:hover': { borderColor: primary, background: appearance['color-surface-container'] } } },
      { props: { color: 'error' }, style: { color: appearance['color-danger'], borderColor: appearance['color-danger'] } },
    ] },
    MuiOutlinedInput: { styleOverrides: { root: { minHeight: token['touch-target'], borderRadius: radius, fontSize: token['type-body'], backgroundColor: appearance['color-surface'],
      '& .MuiOutlinedInput-notchedOutline': { borderColor: fieldOutline }, '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: muted },
      '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: primary, borderWidth: '1px' },
      'html.keyboard-navigation &.Mui-focused': focus,
      '&.Mui-error .MuiOutlinedInput-notchedOutline': { borderColor: appearance['color-danger'] },
      '&:has([aria-invalid="true"]) .MuiOutlinedInput-notchedOutline': { borderColor: appearance['color-danger'] },
    }, input: { padding: `${token['space-2']} ${token['space-3']}`, fontSize: token['type-body'], lineHeight: token['line-height-body'] }, multiline: { padding: token['space-3'] } } },
    MuiInputBase: { styleOverrides: { root: { fontSize: token['type-body'], fontFamily: token['font-family'] }, input: { '&::placeholder': { color: muted, opacity: .8 } } } },
    MuiNativeSelect: { styleOverrides: { select: { padding: '10px 32px 10px 12px', '&:focus': { backgroundColor: 'transparent' } } } },
    MuiPaper: { defaultProps: { elevation: 0 }, styleOverrides: { root: { borderRadius: token['radius-medium'], backgroundImage: 'none' }, outlined: { borderColor: outline } } },
    MuiAccordion: { styleOverrides: { root: { background: 'transparent', borderRadius: '0 !important', '&::before': { display: 'none' }, '&.Mui-expanded': { margin: 0 } } } },
    MuiAccordionSummary: { styleOverrides: { root: { minHeight: token['touch-target'], padding: `0 ${token['space-3']}`, border: `1px solid ${outline}`, borderRadius: radius,
      '&:hover,&.Mui-expanded': { backgroundColor: appearance['color-surface-container'] }, '&.Mui-expanded': { minHeight: token['touch-target'] } },
      content: { minWidth: 0, margin: '8px 0', '&.Mui-expanded': { margin: '8px 0' } },
      expandIconWrapper: { color: appearance['color-text-secondary'], flexShrink: 0, marginLeft: '12px', '& > svg': { fontSize: '20px', width: '20px', height: '20px' } } } },
    MuiAccordionDetails: { styleOverrides: { root: { padding: '8px 0 12px' } } },
    MuiAlert: { styleOverrides: { root: { padding: `${token['space-2']} ${token['space-3']}`, borderRadius: radius, fontSize: token['type-label'], lineHeight: token['line-height-body'], color: appearance['color-text-secondary'], background: appearance['color-primary-container'] }, message: { padding: 0, minWidth: 0 } } },
    MuiMenuItem: { styleOverrides: { root: { minHeight: token['control-height-row'], fontSize: token['type-label'], borderRadius: radius } } },
    MuiListItemButton: { styleOverrides: { root: { minHeight: token['control-height-row'], fontSize: token['type-label'] } } },
    MuiChip: { styleOverrides: { root: { fontSize: token['type-caption'], height: token['chip-height'], borderRadius: token['radius-xs'] } } },
  },
});
export function ReaderThemeProvider({ children }: { children: React.ReactNode }) {
  // One scheme, one theme, no mode storage. The theme carries no colour
  // schemes, so the provider never writes a `light`/`dark` class onto
  // <html>: the panel, the history page and the in-page controls cannot
  // disagree about which palette is active.
  return <ThemeProvider theme={readerTheme}>
    <CssBaseline enableColorScheme />
    {children}
  </ThemeProvider>;
}
