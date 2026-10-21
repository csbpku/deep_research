# Reader design system

Reader consumes the shared `packages/design-system/src/tokens.json` and
`designThemeOptions` → `readerTheme` → MUI. Its generated `tokens.css` also
supplies the isolated webpage controls.
`components/reader-theme.tsx` owns the appearance and interaction states of all
extension controls. `reader-ui.css`, `sidepanel.css`, and `history.css` retain
layout and Markdown formatting, not independent button/input skins.

## Components and boundaries

- Side panel and history: actual MUI Button/ButtonBase, TextField, NativeSelect
  with OutlinedInput, Accordion, Paper, Typography, Chip, Alert, CircularProgress,
  ListItemButton, Menu and MenuItem. Every visible form control is a MUI component.
- `reader-controls.tsx` uses explicit variants and semantic control roles. Legacy
  primary/secondary/text-button classes no longer choose or paint variants.
- `material-runtime.tsx` renders dynamic conversations, evidence, favorites,
  history records, menus, model choices and retry controls in React/MUI roots.
  Controllers supply view data/actions; they no longer assemble buttons or forms
  from HTML. One root is retained per stable region across updates.
- Existing reading controllers retain model, storage and worker coordination.
  Stable native input IDs allow them to set values. The disclosure adapter makes
  expansion explicit through its `open` boundary. This preserves feature behavior
  without maintaining a second visual component system.
- Webpage-injected controls remain isolated Shadow DOM with no second React/MUI
  runtime. The build embeds the same tokens for their fonts, colors, spacing,
  radii, focus states, overlays and reading tools. Article typography is preserved.

## Visual specification

System font with Chinese fallbacks throughout; no downloaded font dependency.
Page headings 20/28 px semibold, section headings 16/24 px semibold, interface
body 14/22.4 px, reading content 15/25.5 px, controls/labels 13/19.5 px, supporting
text 12/19.2 px. Font weight roles are regular 400, medium 500 and semibold 600.

A 4 px token grid and the shared 8 px MUI spacing scale define spacing; extension
layouts use semantic `space` values explicitly. Related controls use 8 px gaps, content
insets 16 px, groups 24 px. Standard controls use an 8 px radius; surfaces 12 px.
Buttons are at least 36 px high, fields 44 px, icon controls 40 px; top navigation
has 44 px targets. The shared header is 52 px high with a 32 px Reader mark and
content-width navigation targets separated by 4 px.

White surfaces, neutral text, shared blue primary color, and semantic status
colors define hierarchy. Selection is indicated by state plus a check or
underline, not color alone. Contained buttons are reserved for the main action;
secondary actions are outlined, save is tonal, supplementary actions are text.
All variants share the same type, radius, focus and disabled states.

Copy and Save appear directly after the latest answer. Each evidence entry owns
its precise source locator. Completion preserves the current reading position.
History records and favorites share the same outlined Paper/card/action patterns.

Suggested followups use one outlined Paper section with a visible title, then
borderless question rows separated by thin dividers. Each row has a trailing
arrow, hover/focus feedback and a minimum 44 px target; clicking sends that
question. Individual questions do not add nested card borders.

The composer model name and its 20 px SVG chevron occupy separate elements,
vertically centered with an 8 px gap. Only the label truncates. The chevron
rotates when the menu opens; the platform model remains noninteractive without
a chevron. Settings disclosures use bordered, 44 px AccordionSummary rows with
20 px chevrons, visible expanded state and keyboard support.

## Verification

The interaction audit checks actual MUI ancestry for visible buttons and fields,
font consistency, mode-card stacking, responsive navigation and feature behavior.
The visual audit checks clipping, accessible labels, target sizes, composer space
and narrow settings/history views. Production CSP remains in effect.
