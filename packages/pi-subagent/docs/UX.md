# pi-subagent UX

## Glance first, detail on demand

Calls lead with the task's short label (the prompt is the fallback). Results,
background widgets and completions share the same vocabulary:

```text
⠹ Audit dependencies running 8s · model
  Reading package manifests…

✓ Audit dependencies done 12s · model
  Found two outdated dependencies
```

A single streaming result always occupies two rows, even before activity arrives.
Parallel results add a progress header and two rows per task; collapsed results
show at most six tasks with an overflow count. The component is reused across
updates. Durations freeze when the run settles. Failures show their reason rather
than an empty success scaffold. Retried and stalled tasks carry short annotations.

Expanded results show turn/token/cost/throughput detail, artifact/session/branch
pointers, and wrapped output (40 lines for a single task, 12 per parallel task).
Overflow points to the artifact or child session. There is no permanent expand
hint for trivial output. Pi's native footer accounts for session cost; the
`/subagent-cost` command and tool `status` retain the separate usage ledger.

All surfaces use native semantic theme tones: accent for queued/running, success
for ready/done, warning for waiting/partial/timeout/stalled/paused, error for
failed/lost, muted for cancelled/history. Untrusted text loses terminal control
sequences before theming. Width is measured in terminal columns, including CJK;
rendering and wrapping use Pi's native ANSI-aware utilities.

## Footer, widget and completion

The terse footer is actionable only: `2 active · 1 ready · /subagents`. It clears
when nothing is active or ready.

The above-editor widget shows only background (`async:true`) tasks. It shares the
two-row result layout, caps at three tasks, and shows overflow without tree or
gear ornaments. Its native component factory uses the current theme and available
width. A 250ms refresh exists only while background runs are live; the widget
clears when they settle or the session shuts down.

Background completions retain their model-facing `followUp` delivery. The human
sees label, outcome, frozen elapsed/model and a summary preview. Accounting and
artifact pointers appear when expanded. Successful completions batch; failures
flush immediately. A prior `wait` delivery suppresses a duplicate notification.

## `/subagents` inspector

- Active, Ready (undelivered), and History groups. Each run leads with its label,
  outcome and elapsed/model, followed by a summary/error preview.
- Selection follows the run ID across new arrivals, reordering and lifecycle
  transitions. If a run disappears, selection falls back to the nearest position.
- List and detail viewports derive from native `tui.terminal.rows`, respecting the
  overlay's 80% height. Resize and PageUp/PageDown use the current viewport size.
- Detail starts with the summary, then per-task output/error, accounting and
  artifact pointers. `t` toggles transcripts on demand, including saved
  transcripts for terminal runs.
- A visible live transcript tails the child session file on a 500ms poll. It
  follows new lines until scrolling up pauses follow. Missing files show a waiting
  message. Hidden, finished or disposed panes do not poll.
- Contextual one-line help shows navigation and actions appropriate to the
  selected state, rather than a permanent dump of every key.

### Keys

| Key | Action |
| --- | --- |
| ↑↓ / j/k, PageUp/PageDown | Select runs or scroll detail |
| Enter | Open detail |
| t | Toggle summary/transcript in detail |
| c / s | Cancel / steer an active child |
| o | Show output pointers |
| r | Resume a terminal run (unless blocked) |
| d | Dismiss a terminal run |
| a / x | Apply / discard changed terminal worktrees (confirmation dialogs) |
| Esc / b / Backspace | Detail back |
| Esc / q | Close list |

Actions remain available even when omitted from contextual help. Steering uses
Pi's input dialog; apply/discard retain native confirmations. Closing resolves the
native custom-UI callback once and disposes subscription, animation and transcript
polling. No separate focus manager or terminal renderer is introduced.

## Budgets and lifecycle

Turn/spend limits are optional: an omitted budget stays undefined unless a named
agent or configured profile explicitly supplies it. There is no schema ceiling at
500 turns, including parallel tasks, and synthesis has no automatic turn cap.
Explicit `max_turns` / `max_cost` still enforce graceful wrap-up and preserve
partial output. Timeout, cancellation, concurrency, nesting, trust and permission
controls are unchanged.

Structural progress updates flush immediately; text bursts use trailing-edge
coalescing. Model-facing content, notification deduplication, usage accounting and
worktree operations are independent of presentation. Headless runs do not need UI.

See [ARCHITECTURE.md](ARCHITECTURE.md) for ownership and
[COST-ACCOUNTING.md](COST-ACCOUNTING.md) for billing.
