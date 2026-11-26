# Recovering a Stuck WorkUnit Effect

An effect left `in_flight` after its owner stopped responding must be recovered explicitly before it can be retried. Recovery clears the recorded claim and changes the effect to `unknown`; it does not decide whether the external Hive/backend action completed.

## 1. Find stuck effects

For a project, inspect recovery candidates with:

```sh
swarmx recover --project <project> --json
```

The command reports recovered effect IDs in `recoveredEffects` and claims on another host in `foreignHostEffects`. Same-host claims whose process is no longer alive are recovered during this command. A foreign-host claim is left untouched until an operator names its effect ID explicitly.

## 2. Explicitly release one claim

After confirming that the owner is no longer responsible for the operation, recover the named effect:

```sh
swarmx recover --effect <id> --project <project> --json
```

Explicit recovery uses the observed claim token as a compare-and-swap guard. It changes the effect to `unknown` and clears the token and owner metadata. A stale token or a project mismatch is refused rather than overwriting a newer claim.

**Recovery never kills or signals a process.** It only updates the effect claim in the database. The old process may still be running; do not assume recovery has cancelled any in-flight external request.

## 3. Replay through the normal workflow

Replay the owning approval or completion through its normal coordinator flow, using the original WorkUnit request and operation/idempotency identity. The effect runner first reconciles Hive state, then claims and executes the effect if the external result is not already confirmed. Do not invent a new operation ID to work around an uncertain result.

## 4. Verify the claim is clear

The replay should settle the effect; check the effect row using a read-only query against the configured swarm database (normally `~/.config/swarm-tools/swarm.db`):

```sql
SELECT state, claim_token, host_instance_id, claimed_hostname, claimed_by_pid
FROM swarmx_effects
WHERE effect_id = '<id>';
```

The settled row must have a non-`in_flight` state and `claim_token IS NULL`. A subsequent `swarmx recover --project <project> --json` should not report this ID as a candidate. If the replay remains ambiguous, leave it for reconciliation rather than killing a process or assuming the external action failed.
