---
"opencode-swarm-plugin": minor
---

> « The purpose of abstracting is not to be vague, but to create a new semantic level in which one can be absolutely precise. »
> — Edsger W. Dijkstra, *The Humble Programmer* (1972)

## 🐝 Durable WorkUnit lifecycle integration

**What changed:** `swarm_complete` accepts optional `operation_id` as a completion identity: replaying the same identity is recognized, while reusing it for a different completion conflicts. Review feedback is durable and keyed by its operation ID. The rebuilt Claude MCP runtime passes the complete arguments object to registered tools; no new agent tool names are introduced.

**Why it matters:** Completion and review feedback can preserve their operation identities across retries, while existing tool entry points remain stable.

**Migration and rollback:** Hive schema changes are owned by `swarm-mail`; this package adds no separate schema migration. The fallback is read-only for one release. Import writes the tombstone last; lifecycle-store writes are disabled, and tombstone-guarded storage rejects lifecycle `set`/`remove` calls. Reads may still use the legacy projection. Raw KV remains technically accessible; only supported lifecycle-store and tombstone-guarded paths are blocked. When rolling back the plugin, WorkUnit lifecycle data lives in the SwarmX database; do not assume legacy KV can be written. The repository's internal, repository-managed `swarmx downgrade` operation is only for use after every mission is terminal; it refuses while any mission is OPEN or CLOSING.

**Backward compatible:** `operation_id` remains optional. Existing callers without it keep their prior behavior, and existing tool names and required arguments are unchanged.
