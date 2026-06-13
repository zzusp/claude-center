import { existsSync } from "node:fs";
import path from "node:path";

// Load the nearest `.env` found by walking up from `startDir` (the repo root in
// this monorepo). Shell-set variables win: `process.loadEnvFile` does not
// overwrite entries already present in `process.env`, so this only fills in
// variables the environment hasn't already provided. A missing `.env` is a
// no-op, which keeps the shell-only workflow working.
export function loadRootEnv(startDir: string): void {
  let dir = startDir;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return;
    }
    dir = parent;
  }
}
