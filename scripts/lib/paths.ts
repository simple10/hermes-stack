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

export const STACK_DIR = resolve(STACK_ROOT, ".stack-node");
export const STACK_ENV = resolve(STACK_DIR, ".env");
export const SERVICES_DIR = resolve(STACK_ROOT, "services");
export const DEFAULTS_ENV = resolve(STACK_ROOT, ".stack.defaults.env");
