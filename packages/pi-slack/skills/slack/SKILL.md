---
name: slack
description: Use Slack channel, thread, search, and posting tools. Use when reading or responding to Slack conversations.
---

# Slack

- Use `slack_thread` when you have a channel and parent timestamp; it returns the complete thread.
- Use `slack_search` only with a user token that has `search:read`; bot tokens cannot use Slack search.
- Always pass `threadTs` when replying in a thread.
- `slack_post` asks for confirmation.
- Authentication: run `/slack-login` interactively or set `SLACK_BOT_TOKEN`/`SLACK_TOKEN`.
