# Reader conversation workspace

2026-10-13. Mode: Redesign · Overhaul. User explicitly authorized a less conservative redesign while retaining the extension's functions. UI UX Pro Max + Web Design Engineer applied.

The actual Chrome sidebar had a stacked wordmark, four-item navigation, status row, notice, source row, reading actions, and a tall composer. History used an unrelated serif promotional layout. The baseline screenshot is `/private/tmp/reader-before-redesign-20261013.png`.

Design Read: a reading companion for laptop users, with quiet utility typography and conversation as the dominant surface. Variance 3, motion 2, density 8 for controls and 5 for answer text, asset dependence 1, brand fidelity 7. The layout removes vertical chrome, keeps text comfortable, and reserves blue for AI/navigation, green for translation, amber for unresolved conditions.

Positioning: the transcript is the working content; viewing distance is a laptop; visual temperature is quiet; capacity is checked at 320×560, 380×860, 520×720, and 736×740. No marketing sections or extra settings are introduced.

System: retain the Reader mark and blue `#3159c9`; white background, ink `#202735`, muted `#667085`, border `#e3e6eb`, neutral fills `#f5f6f8`. Native sans type supports Chinese without remote font loads. Answers are 15px/1.8; controls 12px; metadata 11px. Spacing uses 4/8/12/16/24. Controls use 6–8px radii; composer 22px. Only popovers have meaningful elevation. Hover transitions 160ms; reduced motion disables transitions.

UI UX Pro Max's initial aggregate returned a marketing pattern and scholarly serif pairing that did not fit a compact assistant. A narrower style search verified Minimalism & Swiss Style for professional tools. Its clarity, contrast, essential elements and restrained effects informed this system; the marketing layout and serif fonts were rejected.

Preserve: page extraction, evidence links, selection/image/page scope, all tools, model discovery and validation, background answers, translation pause/restore/retry, annotations, saved conclusions, history search/continue/rename/export/delete, platform connection, import/export, permissions, keys, stable IDs and storage contracts.

Improve: one shared header; one compact source row; full-width borderless assistant answers; one composer with scope above and actions below; history list/detail using the same typography and spacing. Secondary record actions use a disclosure. Navigation retains Chat/Saved/History/Settings labels. No wide-window mode.

Highest risk: moving imperative DOM targets and navigating history while an answer or unsent draft exists. Test the actual controller boundaries; session storage preserves drafts through same-panel history navigation. No credentials or permissions are expanded.


Open WebUI refinement: official current chat screenshots and `MessageInput.svelte` were inspected on 2026-10-13. Sources: https://docs.openwebui.com/features/chat-conversations/chat-features/ and https://github.com/open-webui/open-webui/blob/main/src/lib/components/chat/MessageInput.svelte . The observed reference uses a large-radius composer, grouped tool menu, compact model control, quiet responses, and prompt suggestions. Reader adapts those patterns to a single narrow sidebar: shared 48px header, 36px source row, neutral 22px-radius composer, labeled Summary/Translate/Tools controls, model/settings access beside scope, useful empty-state starter actions, and automatic growth for multiline drafts while retaining drag/keyboard resizing. Older answers gain in-place Copy; the latest answer retains verified-evidence copying and saving. No Open WebUI code, logos, dependencies, or unrelated capabilities are imported.

Selection copy follow-up: when selection scope is active, Copy Selection appears beside the scope control, copies the current original quote, and confirms success. It hides in page scope. Scope labels are non-wrapping and model text truncates at narrow widths. This is a direct action, not buried in Tools.


0.2.11 refinement: live answer, background, inference and history share the same 15px/1.8 typography and Markdown rules. The default view keeps the narrative and verified evidence (blue). Supplementary background, inference and limitations appear inside one collapsed disclosure with a summary of present parts; warnings remain directly visible. On expansion, explicit labels and pale green/purple/amber fills separate these parts; narrative text stays dark. Color is supplementary, following UI UX Pro Max's verified Color Only / Color Contrast guidance. The composer has a neutral border on mouse focus and one visible ring for Tab navigation, avoiding the text-field :focus-visible rule that also matches mouse clicks. Selected original is visible directly above the question input: two lines normally, one at short viewports, with bounded expansion, copy and clear. Scope and the preview describe the next request; a running answer retains the original request context. A paragraph button and dynamic native context-menu label switch original/translation both ways without another model request. These changes preserve source links, storage and task behavior.

Local-only composer model picker: discover/search the current connection models, preserve the selected model when discovery fails, and save switching for the next question. An in-flight worker retains the submitted model. The menu has bounded scrolling, arrow/Escape navigation, refresh and connection settings. Platform mode shows a disabled label without a dropdown arrow and cannot change models.
