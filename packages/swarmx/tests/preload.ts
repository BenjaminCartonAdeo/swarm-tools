// Canonical swarm-mail override: tests must never open the global ~/.config/swarm-tools/swarm.db.
process.env.SWARM_DB_PATH = ":memory:";
