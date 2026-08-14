---
name: graphiti-memory
description: Use shared Graphiti memory through the memory_recall, memory_remember, and memory_status tools — recall durable user preferences, decisions, constraints, environment facts, and outcomes; store new ones before finishing. Use whenever prior-session context may help, the user asks to remember something, or a decision/fact should outlive this session.
---

# Graphiti shared memory

Graphiti (a temporal knowledge graph) is the durable memory store for all
agents. The `pi-graphiti` extension owns a direct connection; relevant facts
are **auto-recalled in the background** from conversation state and delivered
as a dispatch message at the next turn boundary, so most of the time recall
has already happened — check the "Recalled from memory" dispatch block first.

## Tools

| Want              | Tool                                    | Notes                             |
| ----------------- | --------------------------------------- | --------------------------------- |
| Search by meaning | `memory_recall` (mode `facts`, default) | Semantic search over stored facts |
| Find entities     | `memory_recall` mode `nodes`            | People, hosts, services, projects |
| Recent history    | `memory_recall` mode `episodes`         | Chronological raw episodes        |
| Store a fact      | `memory_remember`                       | One small episode per fact        |
| Health check      | `memory_status`                         | Use first if calls fail           |

## When to recall explicitly

Auto-recall covers the current conversation state. Search explicitly when the
task shifts to something the conversation hasn't touched yet: a host you're
about to modify, a service being configured, a decision area being revisited.

## When to store

After durable outcomes: decisions ("we replaced X with Y"), environment facts
("service Z lives on host W"), constraints ("never touch the shared
checkout"), and outcomes of non-obvious debugging. Store before wrapping up
the session, one `memory_remember` call per fact.

Don't store: ephemera, in-progress state, anything derivable from a repo, or
secret values — store _where_ a secret lives, never the value.

## Rules

- Treat recalled facts as claims, not truth: verify against current state
  when acting on them, and cite them ("per memory: ...") so the user can
  correct the graph.
- Facts marked "(superseded)" are historical — do not act on them.
- If tools fail, run `memory_status`, report the state to the user, and
  continue without memory rather than blocking the task.
