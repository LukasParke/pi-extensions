# Coherent extension UI and unbounded defaults

## Outcome

Luke requested a substantial review/cleanup of default behavior and all extension
TUI/UI surfaces, especially subagent visuals. He chose: remove automatic defaults
and hard spend/turn ceilings, while honoring explicit per-run budgets. Preserve
cancellation, timeout, concurrency, nesting, trust, and permission controls.

Native API PR #44 is merged: https://github.com/LukasParke/pi-extensions/pull/44.
This is a separate focused follow-up based on merged main. Herdr requirements were
waived for this conversation; ordinary worktrees, signed commits, PR/CI/review,
merge and cleanup still apply.

## Evidence

- Subagents already omit runtime spend/turn defaults, but their schema hard-caps
  max_turns at 500 and guidance habitually encourages budgets.
- Workflows supply/clamp 20 turns per child; configured spend ceilings also supply
  and clamp defaults. Explicit script budgets must pass through unchanged.
- Subagent inspector uses dense id/state/stat rows, fixed 24-line paging, redundant
  help, and different hierarchy across inline rows/widget/inspector/completions.
- Integration renderers use hardcoded ANSI colors and often ignore width, theme,
  expansion, partial/error state; detail tools fall back to unstructured dumps.
- Other families invent glyphs/status tones/spacing; browser/error-log tools mostly
  lack renderers; dashboard pads headers and stacks extension statuses; Graphiti
  status is unthemed/sticky.

## Presentation contract

Use Pi 0.99 native theme, width, Text/layout/focus/scroll primitives. Do not add a
new design-system dependency/framework. A few small local reusable helpers are
appropriate; domain-specific information stays local.

- Call: one compact line, semantic tool title, muted action/target, no raw ANSI.
- Collapsed result: status + meaningful primary label/count/summary. Keep activity
  stable while streaming. Show elapsed/model only when useful; move detailed
  token/cost/turn metrics to expansion/inspector (the native footer already reports
  session cost). Failure must never render a fake success/empty scaffold.
- Expanded: real body/diff/page/thread/log/artifact detail, deliberate hierarchy,
  bounded visible output and overflow/full-output pointers.
- Status tones: accent for normal activity, success for ready/completed, warning
  for waiting/partial/timeout/stalled, error for failures, muted for cancelled/idle.
- Width: ANSI-aware at 60/80/120 columns, sanitize untrusted control characters,
  preserve CJK/wide characters; no string.length padding assumptions.
- Widgets: bounded glance surface with overflow, consistent terms/tones; clear
  inactive/closed state. Do not add intrusive always-on panels.
- Inspectors: meaningful label first, grouped activity/ready/history, stable
  selection, height-aware viewport, contextual one-line help; summary-first detail,
  transcript on demand. Preserve keyboard actions and cleanup/focus semantics.
- Dialogs/file links: keep native select/input and display-only transformer where
  already appropriate; improve tests/default clarity rather than rewrite.

## Defaults

- No automatic turn/spend ceilings. Remove the subagent 500-turn schema ceiling.
- Workflow missing maxTurns/maxCost stays undefined; explicit request limits are
  honored rather than reduced by trusted-config default ceilings. Retire automatic
  agentMaxTurns/agentMaxCost config policy with clear migration documentation.
- Existing deliberate per-run budgets still enforce wrap-up/accounting. Do not
  silently drop a human-requested limit or weaken safety/timeouts.
- Review chat/progress/completion noise, but retain real lifecycle/notification
  guarantees and useful model-facing output.

## Work slices

1. Subagent reference visuals, inspector, widget/completion hierarchy and optional-
   budget guidance/schema; native-rendered state/width/focus snapshots.
2. Integration tools: theme-driven compact/expanded/empty/error/result/call contract
   across Git/GitHub/Slack/Linear/Notion, including currently missing detail rows.
3. Browser/search/error-log presentation and progress aligned to the same contract;
   preserve images/structured data/model-facing content and safety.
4. Workflow unlimited defaults, inspector/widgets/tool rows; background/sentinel/
   gauntlet status/widget coherence; Graphiti health cleanup; dashboard density;
   native dialog mode tests. Review every remaining package and document no-op
   decisions for libraries/display-only surfaces.

## Verification

Run npm run check after every edit cycle, relevant package checks, pack:check,
actual native registration/runtime loading, and snapshot/state matrices. Test
collapsed/expanded/partial/terminal/error/no-UI, 60/80/120 and narrow widths, theme
changes, inspector focus/scroll/cancel/close, notification suppression/cleanup,
and explicit/no-budget policy at the real runner seam. Use fixtures/mocks; no
owner credentials/services or live model mutations.

Documentation and package versions/dependent ranges follow the final diff. Parent
owns signed commits, focused PRs, independent review, CI fixes, merge, canonical
fast-forward/install/verification and worktree cleanup.
