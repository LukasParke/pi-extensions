# Native Pi API audit

Audit date: 2026-09-29. Target: latest stable Pi **0.99.1**, verified against the
published npm package, changelog, declarations, and SDK behavior. The repository
previously developed against Pi 0.84.1.

## Upgrade contract

Upgrade Pi and restart before loading these tool-package versions. Reloading
extensions does not upgrade the running host. Host-provided package peers remain
`*`, following Pi's packaging guidance; the documented supported parent host is
0.99.1 or newer.

Public tool names and ordinary direct-call defaults are retained. `ask_user`,
`subagent`, `subagent_wait`, and `workflow` use native `model-only` exposure: they
remain model-callable, but are not available through codemode or nested tool calls.
Their user-dialog/child-agent behavior is not replaced by same-session scripting.

All 72 tools have namespaces and effect annotations. The 68 other tool definitions
have business output schemas and matching structured results; their normal active-
tool and runtime-availability gates still determine script access. Model-facing text,
rendering details, progress, images, and existing safety gates remain available.
Annotations describe effects; they are not authorization or a security boundary.

## Native tool consumption

Pi's native codemode receives `structuredContent` for a tool with an output
schema, rather than its rendered text. For example:

```js
const status = await tools.git_status({});
if (status.refused) throw new Error(status.error);
return { branch: status.status.branch, changed: status.status.files.length };
```

Refusals carry error data and native `isError`; an error result with structured
data can still resolve in scripts, so inspect the failure alternative. Empty
searches, pending work, intentional partial results, user dismissal, and already-
gone tasks are not uniformly treated as execution errors.

Search outputs preserve useful bounded data: `fd.paths`, `rg.output`, and raw
`rg.lines` including context and colon-containing filenames. Truncated results
provide the full output path. Background status exposes normalized process/log
snapshots without process handles, and reports bytes omitted by its own tail cap.
Images include a tagged image block, suitable for `image(result.image)`.

Nested calls retain Pi's permission pipeline, cancellation, sequential execution,
parent attribution, and automatic nested-usage accounting. Auth and confirmation
requirements do not disappear inside scripts.

## Lifecycle and accounting

- Dispatch releases its API/context binding on shutdown so a replacement runtime
  can rewire once. Multiple consumers in the same live runtime remain idempotent.
- Graphiti and background terminals suppress late deliveries from shut-down
  instances; background terminals also cancel pending delivery timers.
- The subagent RPC parser handles `prompt` disposition `handled`, where no agent
  run or settled event follows. Started, queued, and older responses remain valid.
- Herdr, Graphiti, and Ultracode use native prompt sections instead of replacing
  the full system prompt. One-shot thinking restores only after final settlement.
- Herdr name generation uses the configured provider runtime and reports its paid
  usage, including dispatch failure after naming. Cancellation during naming stops
  subsequent dispatch before side effects begin.
- Failed/lost subagent deliveries preserve native error, result, and paid usage
  together. Re-delivery never double-counts usage.
- Workflow tool delivery reports newly executed child usage once. Replayed
  journal usage remains visible in summaries but is not charged again.
- OpenRouter's direct-stream benchmark normalizes the current transcript on each
  request, preserving system/tools and all preceding assistant/tool-result turns.
- File search uses the native agent-directory resolver, gauntlet uses the native
  configuration-directory name, and PDF writes use the native file-mutation queue
  with paths resolved against the tool context's working directory.

## Package decisions

| Package                 | Decision                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| pi-ask-user             | Native model-only exposure; keep TUI/RPC dialogs and dismissal behavior.                                                              |
| pi-background-terminals | Native process/log results, honest effect hints, shutdown cleanup; keep the async manager.                                            |
| pi-dashboard            | Already uses native TUI factories, capabilities, width helpers, and supported themes; no novelty-only rewrite.                        |
| pi-dispatch             | Repair runtime replacement ownership; preserve batching, priorities, and deduplication.                                               |
| pi-error-log            | Native query schema and parent attribution; keep durable redacted JSONL history.                                                      |
| pi-ext-config           | Keep the host-independent defaults/file/env loader and explicit path override contract.                                               |
| pi-file-links           | Already uses the native markdown transformer and hyperlink capability helpers.                                                        |
| pi-file-search          | Native directory/data/hints; keep specialized filtering and partial-I/O semantics.                                                    |
| pi-firecrawl            | Native schemas/errors/hints; keep curated REST tools, progress, and cancellation.                                                     |
| pi-gauntlet             | Native result/error/config contracts; keep final-settlement verification and follow-ups.                                              |
| pi-git                  | Native repository business data and hints; arbitrary checklist commands remain conservative.                                          |
| pi-github               | Native PR/check/comment/auth data and errors; retain confirmation and approval guards.                                                |
| pi-graphiti             | Native memory data/prompt/lifecycle contracts; keep off-turn recall and its client.                                                   |
| pi-herdr                | Native configured-provider naming, prompt sections, data, and accounting; retain real managed-context/trust/cleanup guards.           |
| pi-integration-auth     | Existing native dialog guards, masked setup, credential precedence, and file permissions remain appropriate.                          |
| pi-integration-http     | Pure bounded-retry HTTP library; no Pi-specific rewrite needed.                                                                       |
| pi-integrations         | Bundle inherits all 35 provider contracts; document native MCP/OAuth as an alternative.                                               |
| pi-linear               | Native issue/state/comment/auth schemas and truthful effect hints.                                                                    |
| pi-notion               | Native page/block/search/append/auth schemas and hints.                                                                               |
| pi-openrouter           | Native transcript normalization; retain the full live catalog and benchmarked multi-surface routing.                                  |
| pi-sentinel             | Native snapshots/hints; keep external criteria and quiet-window wakeups.                                                              |
| pi-slack                | Native channel/thread/search/post/auth data; retain confirmation and credential behavior.                                             |
| pi-steel                | Native data/images, sequential shared-session execution, file queue, and effect hints; keep REST/CDP and authenticated browser state. |
| pi-subagent             | Native exposure/error/usage contracts and RPC disposition handling; keep budgets, backends, worktrees, retries, and guards.           |
| pi-workflows            | Native prompt/lifecycle/error/accounting contracts; keep journals, replay, dynamic control flow, and worktree lanes.                  |

## Why custom capabilities remain

Native codemode orchestrates tools in the current session; it does not own child
agent budgets, worktree lanes, retries, background registries, or journal replay.
Native bash is blocking and has no session-scoped asynchronous terminal manager.
Native find/grep do not preserve all fd/rg filtering, case, multiline, partial-I/O,
or binary-provisioning semantics.

Native MCP registration is not equivalent to Graphiti's off-turn recall, because
`ctx.executeTool` is a tool-context API, not an event/timer API. REST integrations,
Firecrawl crawl progress, and persistent CDP browser behavior also lack demonstrated
MCP parity. No user MCP configuration, credentials, browser login, or installed
harness is automatically migrated.

Pi's native catalog refresh overlays the Pi catalog; it does not replace the full
OpenRouter catalog generator or its benchmark-pinned API-surface choices.

## Verification

`npm run check` gates types, formatting, and the unit/integration suite;
`npm run pack:check` verifies every package and the installed integration bundle.
Contract tests validate actual result branches against declared schemas, including
refusals, no-match, images, and partial states. Real SDK tests exercise native
codemode, permission blocking, nested usage and parent attribution, sequential
execution, cancellation, prompt-section composition, and runtime replacement.

Tests use temporary repositories/processes, mocked service transports/CDP, isolated
auth paths, and a local fixture model provider. They do not post to real services or
modify owner credentials. Latest-host factory loading is checked separately;
loading alone is not proof of session-start or execution behavior. Live provider
benchmarks, browser logins, and real Herdr dispatch remain outside automated checks.
