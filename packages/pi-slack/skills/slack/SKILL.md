---
name: slack
description: Use Slack channel, thread, search, and posting tools. Use when reading or responding to Slack conversations.
---

# Slack

Requires Pi 0.99.1+. Tools are grouped under the native `slack` namespace;
call them in `codemode` as `await tools.slack_search({ query, limit })`, etc.
Results are structured business data: channel/search `rows`, a `thread` with
`messages`, post `channel`/`ts`, or connection status. Check `result.refused`
before reading success fields; refusals carry `error` and set `isError: true`.
An empty `rows` array is a successful no-match result. Text and UI details remain available.

- Use `slack_thread` when you have a channel and parent timestamp; it returns the complete thread.
- Use `slack_search` only with a user token that has `search:read`; bot tokens cannot use Slack search.
- Always pass `threadTs` when replying in a thread.
- Prefix outgoing messages with `Agent:`; `slack_post` asks for confirmation.
- `slack_connect` requires interactive confirmation and has no bypass flag.
- Authentication: run `/slack-login` interactively or set `SLACK_BOT_TOKEN`/`SLACK_TOKEN`.
