---
"swarm-mail": minor
---

> « The purpose of abstraction is not to be vague, it is to create a new semantic level. »
> — Barbara Liskov

## 🐝 Durable identity across Hive and review feedback

**What changed:** Hive v11 adds nullable `operation_id` and its partial unique index. Hive v12 separately adds nullable, unique `completion_operation_id`, exposed in the `cells` view. The package also exports additive durable review-feedback and recovery APIs.

**Why it matters:** Operation identity can be persisted for idempotent feedback and completion while keeping the additive lifecycle/recovery APIs available to callers that need them.

**Migration and rollback:** Apply the numbered migrations in order. Rolling back v12 → v11 removes `completion_operation_id`; rolling back v11 → v10 discards `operation_id`. The fallback is read-only for one release. Import writes the tombstone last; lifecycle-store writes are disabled, and tombstone-guarded storage rejects lifecycle `set`/`remove` calls. Reads may still use the legacy projection. Raw KV remains technically accessible; only supported lifecycle-store and tombstone-guarded paths are blocked.

**Backward compatible:** Readers selecting existing named columns remain compatible. `SELECT *` readers observe changed column counts as the new fields are added, and should select columns explicitly. Both operation IDs are nullable, so existing rows need no synthesized identity.
