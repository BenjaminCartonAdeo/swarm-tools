---
"opencode-swarm-plugin": minor
---

## 🐝 Read-Only Cells Can Finally Finish

A swarm mission could not close when it contained an audit cell. Audits change no
files, and every layer of the protocol assumed a non-empty `files_touched` list, so
the coordinator hit a wall: no completion, no scoped review, no `swarm_finish`.
The only escape was cancelling the mission.

**What changed:**

- `swarm_complete` accepts `read_only: true` together with an empty `files_touched`.
  Without the flag, an empty list is still rejected.
- The completion receipt records `readOnly`, and that receipt — not the caller — is
  the authority: `swarm_review` only skips the scoped-diff requirement when the
  pending completion was actually submitted read-only.
- Read-only reviews produce a usable `ScopedReviewReceipt` and flow through
  `swarm_review_feedback` exactly like a code review.
- `swarm_spawn_researcher` gains `cell_kind: "research" | "audit"`. Audit cells get a
  read-only audit prompt (evidence with `file:line`, no edits, no documentation
  fetching) instead of the documentation-research prompt.
- `swarmmail_init` accepts an `agent_name` that matches the V2 caller after
  normalisation (case, spaces, hyphens), so the coordinator no longer needs a retry
  loop on an identity that was already correct.

**Why it matters:** a mission with three implementation cells and two audit cells no
longer deadlocks on the audits. Zero-touch reviews and write cells keep the stricter
contract: a non-empty file list and a complete diff are still mandatory.

**Compatibility:** additive. `read_only` defaults to `false` and `cell_kind` defaults
to `"research"`, so existing callers see identical behaviour.

```
      .-.
     (o o)  "I read everything. I changed nothing."
     | O |  "Still need a receipt? Fine, here's one."
      '-'
```
