# @parke.dev/pi-dispatch

Session-level notification queue for [pi coding agent](https://pi.dev) extensions.

Sentinel events, subagent run completions, watchdog escalations, and workflow
results all need to reach the same place: the orchestrator's session. Without a
shared queue each extension batches privately and the orchestrator gets woken
three times for three sources. This package is the single queue they publish
into and the one delivery path that drains it.

It is a library, not an extension — it registers no tools and no skills.

## Install

```bash
npm install @parke.dev/pi-dispatch
```

Do not `pi install` this package — there is no extension entry. Other
extensions depend on it; one extension in the process should call
`ensureDelivery(pi)` to wire delivery.

## Semantics

- **Accumulate while busy.** Published items queue while the agent is mid-turn
  and flush only when the session is idle, after a 2s coalescing quiet window
  that resets on every publish.
- **Drain once on settle.** One message per batch, grouped by priority:
  escalations → completions → info. `triggerTurn` is set only if at least one
  item is wake-urgent; an all-`next-turn` batch is delivered without waking the
  model.
- **Fold, don't stack.** Publishing the same `id` replaces the queued item with
  the latest state and increments `foldCount` (rendered as `(xN)`).
- **Suppress cancelled sources.** `suppress("sentinel")` drops queued items from
  `sentinel` and every `sentinel:*` sub-source before delivery.
- **Pull interface.** `peek()` and `size()` inspect the queue without spending
  a turn.
- **Shared instance.** The queue is registered on `globalThis` under
  `Symbol.for("parke.dev/pi-dispatch")`, so separately installed packages in
  the same process publish into and drain from one queue.

## Usage

Publish from any extension:

```ts
import { dispatchQueue } from "@parke.dev/pi-dispatch";

dispatchQueue().publish({
  id: "gate:all-pass", // dedupe key; republishing folds into one item
  source: "sentinel:gate",
  priority: "escalation", // "escalation" | "completion" | "info"
  urgency: "wake", // "wake" | "next-turn"
  message: "SENTINEL GATE: ALL PASS",
  details: { passes: { lint: true, tests: true } },
});
```

Exactly one extension wires delivery per session; later callers no-op:

```ts
import { ensureDelivery } from "@parke.dev/pi-dispatch";

export default function (pi: ExtensionAPI) {
  ensureDelivery(pi);
  // ...
}
```

## API

```ts
export type DispatchPriority = "escalation" | "completion" | "info";
export type DispatchUrgency = "wake" | "next-turn";

export interface DispatchItem {
  id: string; // dedupe key
  source: string; // e.g. "sentinel:pr-24"
  priority: DispatchPriority;
  urgency: DispatchUrgency;
  message: string; // markdown for the batch body
  details?: Record<string, unknown>;
  foldCount: number; // starts 1, maintained by the queue
}

export interface DispatchQueue {
  publish(item: Omit<DispatchItem, "foldCount">): void;
  suppress(sourcePrefix: string): number; // drops source === prefix or prefix + ":*"
  peek(): DispatchItem[];
  size(): number;
}

export function dispatchQueue(): DispatchQueue; // per-process singleton
export function ensureDelivery(pi: ExtensionAPI): void; // idempotent
export function formatBatch(items: DispatchItem[]): string; // markdown batch body
```

Publishing before `ensureDelivery` runs is safe: items queue but do not flush
until delivery is wired and the session is idle. `session_shutdown` clears the
queue, and a failed `sendMessage` leaves the batch queued for the next drain.

## License

MIT
