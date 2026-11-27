---
"swarm-tools": minor
---

> « The purpose of abstracting is not to be vague, but to create a new semantic level in which one can be absolutely precise. »
> — Edsger W. Dijkstra, *The Humble Programmer* (1972)

## MCP keeps optional operation identity intact

**What changed:** The MCP tool bridge accepts and forwards the complete JSON argument object, including optional `operation_id`, to the Swarm CLI unchanged.

**Why it matters:** Callers can pass an idempotency key across the MCP/CLI boundary without a separate adapter-specific translation.

**Migration and rollback:** No migration is required. If rolling back this bridge change, callers should stop relying on `operation_id` being forwarded through this package.

**Backward compatible:** `operation_id` remains optional. Existing callers that omit it continue to work, and omission stays omission; no new tool names or required arguments are introduced.
