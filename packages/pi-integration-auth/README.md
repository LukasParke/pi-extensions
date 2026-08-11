# @parke.dev/pi-integration-auth

Shared authentication support for the integration packages in this repository.

It is a library, not a Pi extension. Users normally install `@parke.dev/pi-github`, `pi-slack`, `pi-linear`, `pi-notion`, or the `pi-integrations` bundle rather than installing this directly.

## Resolution order

1. Provider environment variables
2. `~/.pi/agent/integration-auth.json`
3. A provider CLI credential when supported (`gh auth token` for GitHub)

The agent directory follows `PI_CODING_AGENT_DIR`; no home path is hardcoded.

## Interactive setup

Provider packages register `/github-login`, `/slack-login`, `/linear-login`, and `/notion-login`. These commands use a masked terminal prompt, validate the credential before storing it, and never put it in the model conversation or session JSONL.

Saved credentials use an atomic temporary-file + rename write and mode `0600`. Environment variables always win, making CI and per-shell overrides predictable.

## Security boundary

A `0600` file is readable by any process running as the same OS user. Use environment variables or an external credential helper if that is not an acceptable boundary for your machine.
