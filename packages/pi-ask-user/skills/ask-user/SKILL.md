---
name: ask-user
description: Ask the user one multiple-choice question via ask_user when the right course of action is genuinely ambiguous and guessing would waste work. Prefer proceeding on judgement when stakes are low; one question per call.
---

# Ask User

Use `ask_user` when committing to the wrong fork burns a whole turn — which library,
which of several files, migrate vs rewrite, keep vs delete. Do **not** use it for
low-stakes choices you can reverse cheaply; pick and state the assumption instead.

## Call shape

```
ask_user {
  question: "Which approach should we take?",
  options: [
    { label: "Migrate in place", description: "optional clarifying detail" },
    { label: "Rewrite the module" }
  ]
}
```

- `question` — one short, concrete question.
- `options` — 2–5 distinct choices. A free-text option is always appended for the user.
- Ask **exactly one** question per call. Do not stack several decisions into one prompt.

## Outcomes

| User action                         | What you get                                      |
| ----------------------------------- | ------------------------------------------------- |
| Picks an option                     | `The user chose: <label>`                         |
| Picks free text and types an answer | `The user answered (free text): …`                |
| Dismisses (Esc)                     | Told they dismissed — do **not** invent an answer |
| Free text with nothing submitted    | Treated as no answer                              |
| No interactive UI                   | Told to decide yourself and state the assumption  |

If the user dismisses or gives no answer, either ask a sharper question once more
or proceed with an explicit assumption. Never pretend they chose.
