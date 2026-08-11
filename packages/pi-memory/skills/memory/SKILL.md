---
name: memory
description: Store, search, and remove durable facts across Pi sessions. Use when the user asks to remember something or when prior-session facts may help.
---

# Memory

- Store concise durable facts with `memory_remember`; do not store transient task state.
- Use global scope unless the fact is only true for one project.
- Search with `memory_recall` before asking the user to repeat durable context.
- Remove incorrect or unwanted facts with `memory_forget` using an id returned by recall.
- Never store secrets; the extension redacts common credential formats, but prevention is better than redaction.
