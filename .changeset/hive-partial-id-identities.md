---
"swarm-mail": patch
"opencode-swarm-plugin": patch
---

> « The purpose of abstracting is not to be vague, but to create a new semantic level in which one can be absolutely precise. »
> — Edsger W. Dijkstra, *The Humble Programmer* (1972)

## 🐝 Partial cell lookups keep their operation identities

`hive_cells({ id })` and other partial-ID lookups now preserve `operation_id` and `completion_operation_id` instead of silently returning `null`.

**Why it matters:** Approved completions could be closed with the correct durable identity in the database while the public lookup output appeared to have no identity, making reconciliation and audit misleading.

**Backward compatible:** The fields were already part of the cell contract; this restores them on the partial-ID query path without changing tool names or arguments.
