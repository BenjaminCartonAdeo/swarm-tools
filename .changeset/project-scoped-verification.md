---
"opencode-swarm-plugin": patch
---

## 🐝 Run Verification in the Target Project

`swarm_complete` now passes `project_key` into the verification gate. The gate resolves `tsconfig.json` and touched test paths from that project and runs checks with the project's directory as its working directory. This prevents an OpenCode server started from another directory from skipping checks or testing the wrong project.

No public API change.
