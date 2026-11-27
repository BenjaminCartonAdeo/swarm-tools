---
"swarm-mail": minor
"opencode-swarm-plugin": patch
---

> « The purpose of abstracting is not to be vague, but to create a new semantic level in which one can be absolutely precise. »
> — Edsger W. Dijkstra, *The Humble Programmer* (1972)

## 🐝 Tests stop targeting the real swarm database

Streams tests now use guarded temporary database paths, so cleanup can no longer unlink `~/.config/swarm-tools/swarm.db`. `SWARM_DB_PATH` also preserves legacy migration behavior instead of bypassing it.

## Durable completion signals work across processes

DurableDeferred accepts an optional stable key and always resolves through its persisted database state. This fixes completion signals that were written to SQLite but never observed by an in-memory waiter. Schema validation now sees SQLite generated columns, and missing optional AI credentials degrade quietly without network calls.

**Backward compatible:** Existing deferred callers can omit `key`; random URLs remain the default. Public swarm tool names and arguments are unchanged.
