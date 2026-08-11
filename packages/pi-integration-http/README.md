# @parke.dev/pi-integration-http

Shared, dependency-free HTTP primitives used by the GitHub, Slack, Linear, and Notion Pi integrations.

It provides:

- bounded retries with safe read/write asymmetry
- provider-aware rate-limit metadata
- token-bucket limiting and a circuit breaker
- bounded pagination
- TTL caching
- structured, non-secret-bearing errors

This is a library, not a Pi extension. Install a provider package or `@parke.dev/pi-integrations`; npm brings this package in automatically.
