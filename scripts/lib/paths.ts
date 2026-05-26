// paths.ts — resolve hermes-stack root + stack dir hermetically.
//
// STACK_ROOT is derived from THIS file's own location (mirrors stacklib.sh's
// "never trust ambient env" rule). If the resolved dir doesn't look like the
// hermes-stack root we die loudly.
//
// .stack-node/ is the parallel-tree state dir — keeps this CLI from
// stomping on the existing bash .stack/ until cutover. Search-replace
// ".stack-node" → ".stack" when we're ready.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const STACK_ROOT = resolve(here, "..", "..");

if (
  !existsSync(resolve(STACK_ROOT, "lib", "stacklib.sh")) ||
  !existsSync(resolve(STACK_ROOT, ".stack.defaults.env"))
) {
  console.error(
    `FATAL: stack-cli could not locate the hermes-stack root (resolved "${STACK_ROOT}").`,
  );
  process.exit(1);
}

// HERMES_STACK_DIR_OVERRIDE is a TEST-ONLY hook: vitest sets it to a
// per-test temp dir so block/upsert/cascade logic can be exercised without
// touching the real .stack-node/.env. Never set this in production — the
// dc()/orchestrator path strips it from the host env anyway.
export const STACK_DIR = process.env.HERMES_STACK_DIR_OVERRIDE
  ? resolve(process.env.HERMES_STACK_DIR_OVERRIDE)
  : resolve(STACK_ROOT, ".stack-node");
export const STACK_ENV = resolve(STACK_DIR, ".env");
export const SERVICES_DIR = resolve(STACK_ROOT, "services");
export const DEFAULTS_ENV = resolve(STACK_ROOT, ".stack.defaults.env");
