# @parke.dev/pi-ask-user

One tool for the [pi coding agent](https://pi.dev): `ask_user`. Lets the model
ask you a single multiple-choice question when the right course of action is
genuinely ambiguous and guessing would waste a whole turn.

A free-text option is always appended, and you can dismiss the prompt without
answering — the model is told honestly either way, so it does not invent a
choice.

## When it helps

Use it when committing to the wrong fork burns work, for example:

- which of several concrete options you meant (library, file, approach)
- migrate vs rewrite, keep vs delete, A vs B API design
- any low-stakes-looking choice that is expensive to reverse mid-turn

Prefer proceeding on judgement when the stakes are low. One question per call.

## Parameters

| Field                   | Type              | Notes                                                           |
| ----------------------- | ----------------- | --------------------------------------------------------------- |
| `question`              | string (required) | The single question. Keep it short and concrete.                |
| `options`               | array, 2–5 items  | Distinct choices. A free-text option is appended automatically. |
| `options[].label`       | string (required) | Short option text.                                              |
| `options[].description` | string (optional) | Clarifying detail; shown inline with the label.                 |

### What comes back

| Outcome                               | Result                                               |
| ------------------------------------- | ---------------------------------------------------- |
| You pick an option                    | `The user chose: <label>`                            |
| You pick free text and type an answer | `The user answered (free text): …`                   |
| You dismiss (Esc)                     | Told you dismissed — model must not assume an answer |
| Free text with nothing submitted      | Treated as no answer                                 |
| No interactive UI                     | Told to decide and state the assumption              |

## Install

```bash
pi install npm:@parke.dev/pi-ask-user
```

Needs an interactive UI (`ctx.hasUI` — the TUI, or RPC sessions that can show
dialogs). In `-p` / print mode and other non-interactive sessions the tool does
not block: it returns immediately saying there is no UI, and the model should
decide, state its assumption, and continue.

## License

MIT
