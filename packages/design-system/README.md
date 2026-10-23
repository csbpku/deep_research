# Shared design system

Web and Reader share appearance, not business logic or runtime state.

- `src/tokens.json`: the light appearance and common type, spacing, shape and layout scale.
- `src/dark.json`: explicit overrides for every color and elevation in dark mode.
- `src/theme.ts`: pure MUI ThemeOptions factory with named typography variants; MUI/React/Emotion are peers, not bundled runtimes.
- `generated/tokens.css`: `--dr-*` variables for CSS Modules and non-React DOM.

Run from the repository root:

```sh
pnpm --filter @deep-research/design-system generate
node apps/extension/scripts/generate-design-system.mjs
pnpm --filter @deep-research/design-system test
pnpm --filter @deep-research/design-system typecheck
```

Generated CSS is checked into the source tree and must not be edited by hand. `build` checks that it is current. The Reader generator also has a `--check` mode; tests check both consumers and light/dark normal-text contrast, including source and reading-tier labels.

MUI spacing uses an 8px base: `sx={{ p: 3 }}` means 24px. Import `space.md` for 12px. Use named typography variants (`pageTitle`, `panelTitle`, `listTitle`, `fieldTitle`, `reading`, `control`, `metadata`) rather than per-page scales. Breakpoints are 0/640/768/1024/1280px; preserve existing workflow layout at these boundaries.

The workspace uses injected packages for Web's React peer context. After changing shared source, exports, or generated CSS, run `pnpm install --frozen-lockfile` to synchronize the injected copy before building; checking only the source generator does not validate the installed snapshot. Docker must copy this package's source and generated files before dependency installation; a package.json-only copy is insufficient. Reader continues to use its own React peer without injecting that runtime into Web.

Current runtime boundaries: [technical overview](../../docs/TECHNICAL_OVERVIEW.md).
