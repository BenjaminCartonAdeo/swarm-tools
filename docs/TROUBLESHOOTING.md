# Swarmx Troubleshooting

## Hive unavailable
- Ensure `hive` shim or server is available.
- Run `swarm serve` to start hive server.

## Grader unavailable
- Configure opencode model router preset (e.g. opencode-go) for heavy tier.
- Verify model availability with `swarm doctor`.

## Untracked files in review
- `swarm_complete` now stages untracked files with `git add -N` (best-effort).
- Ensure files_touched includes new files.

## Coordinator identity
- Run as canonical coordinator agent; otherwise swarm_set_budget/finish are refused.
