# @benjamin/swarmx

OpenCode V2 plugin for swarm mission orchestration: dispatch gating, idempotent ledger settlement, compaction contributions, and a token-pressure watchdog.

## Install (local)

```bash
cd /home/benjamin/Dev/.opencode
bun install
```

The plugin is resolved from `node_modules` via the `file:` dependency declared in `.opencode/package.json`. No source code is copied into `.opencode/plugins/`.

## OpenCode configuration

`.opencode/opencode.json`:

```json
{
  "plugins": ["@benjamin/swarmx"]
}
```

## Build

```bash
cd /home/benjamin/Dev/swarm-tools-fork/packages/swarmx
bun run build
bun run typecheck
bun test
```

## Assets

Agents, the `swarmx` command, and skills are shipped under `assets/` and installed by the `swarmx` CLI (`swarmx install`).

## License

MIT