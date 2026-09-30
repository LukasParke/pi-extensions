# Native extension presentation and optional budgets

Requires Pi 0.99.1 or newer. Packages retain wildcard host peer dependencies;
this requirement describes the native APIs used, not a pinned host installation.

## Information hierarchy

Calls show the action and target. Collapsed results prioritize state, meaningful
labels and concise summaries. Expansion reveals actual diagnostics, bodies,
patches and artifacts, with explicit overflow notices rather than unbounded
scrollback. Renderers use native theme and ANSI-aware width handling.

Activity is accent; completion is success; waits, partial results and timeouts
are warning; failures are error; cancellation and idle state are muted. Active
subagent rows stay fixed-height even when expanded. Images remain native image
components, separate from custom text renderers. Tool text and structured results
remain available to the model; display limits do not become business-data limits.

## Run inspectors

- `/subagents`: label-first Active / Ready / History groups, ID-stable selection,
  height-aware scrolling and summary-first detail. Transcripts are on demand.
  Existing cancel, steer, resume, output, apply and discard actions remain.
- `/workflows`: compact activity and ready counts, child labels and phase context,
  with cancellation and detailed output in the inspector.
- Background terminal and Sentinel widgets bound their visible entries and
  disclose overflow. `/ps` and `sentinel_status` retain full inspection.
- The dashboard remains disabled by default. Its opt-in header uses one row;
  the footer previews at most two extension statuses. `/dashboard status`
  inspects their full text locally, without injecting it into model context.
- Memory availability warnings clear on successful `memory_status` checks and
  shutdown. Native question dialogs distinguish cancellation from dismissal and
  release blocked-state indicators on every outcome.

## Budget migration

Built-in spend and turn defaults/ceilings are removed, not safety controls.

| Surface                               | Omitted budget                                                                  | Explicit budget                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Subagent `max_turns` / `max_cost`     | No built-in limit; deliberately configured persona/profile defaults still apply | Preserved, including more than 500 turns                              |
| Parallel synthesis                    | No automatic eight-turn cap                                                     | Existing requested/configured task budget behavior remains            |
| Workflow child `maxTurns` / `maxCost` | Unbounded                                                                       | Passed through unchanged, including values above the retired ceilings |

Workflow `agentMaxTurns`, `agentMaxCost`, `PI_WORKFLOW_AGENT_MAX_TURNS` and
`PI_WORKFLOW_AGENT_MAX_COST` are retired and ignored. Move deliberate limits to
individual calls:

```js
const research = await agent("Explore the source", { profile: "explore" });
const bounded = await agent("Implement the fix", { maxTurns: 40, maxCost: 2 });
return { research, bounded };
```

Explicit limits still trigger the existing wrap-up/partial-result behavior.
Timeouts, cancellation, concurrency, nesting, workflow request counts, worktree
isolation, trust, confirmation/auth and permission guards are unchanged.
Gauntlet iteration limits and external monitor polling are separate lifecycle
controls and are not removed.

## Package coverage

| Packages                                                                     | Decision                                                                                |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `pi-subagent`, `pi-workflows`                                                | Reference run hierarchy, inspectors, compact widgets and optional budgets               |
| `pi-git`, `pi-github`, `pi-slack`, `pi-linear`, `pi-notion`                  | Native themed call/result rendering, detail expansion, partial/empty/error states       |
| `pi-steel`, `pi-firecrawl`                                                   | Native browser result states and expansion; image and full-output delivery retained     |
| `pi-file-search`, `pi-error-log`                                             | Width-aware search/log previews, expansion and diagnostics                              |
| `pi-background-terminals`, `pi-sentinel`, `pi-gauntlet`                      | Bounded themed status widgets; lifecycle/notification controls retained                 |
| `pi-graphiti`, `pi-dashboard`, `pi-ask-user`, `pi-herdr`                     | Health cleanup, compact opt-in chrome, native dialog cancellation, task lifecycle rows  |
| `pi-dispatch`, `pi-ext-config`, `pi-integration-auth`, `pi-integration-http` | Libraries, not independent UI; retain native consumers and existing policy              |
| `pi-integrations`                                                            | Bundle inherits provider renderers; dependency ranges advance with them                 |
| `pi-file-links`                                                              | Existing display-only native Markdown transformation retained; no new panel             |
| `pi-openrouter`                                                              | Existing native command dialogs/notifications retained; no separate rendering framework |

## Verification scope

Regression tests execute registered render callbacks at narrow, 60, 80 and 120
columns, exercise state/expansion/theme variations and inspect lifecycle cleanup.
Subagent fixtures prove fixed-height streaming and tiny-viewport selection.
Integration fixtures preserve complete expanded errors, mutation URLs and merge
blockers. Browser fixtures cover unpolled crawl timeouts and genuine output
pointers after misleading page text.

Deterministic subprocess tests connect workflow budget normalization to the real
ChildRunner: an omitted budget completes 510 fixture turns; explicit turn and
spend limits stop with their existing reasons. No live model, service credentials,
owner browser session or globally installed Pi is modified by these tests.
These are native component/fixture checks, not a claim of manual terminal use.
