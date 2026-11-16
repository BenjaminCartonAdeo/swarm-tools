#!/usr/bin/env bun
import { existsSync, renameSync } from "fs";
import { homedir, join } from "path";

const dbPath = join(homedir(), ".config", "swarm-tools", "swarm.db");
if (!existsSync(dbPath)) {
  console.log("Aucune DB à réinitialiser.");
  process.exit(0);
}
const backup = `${dbPath}.reset.${Date.now()}`;
renameSync(dbPath, backup);
console.log(`swarm.db réinitialisée → ${backup}`);
