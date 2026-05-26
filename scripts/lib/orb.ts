// orb.ts — OrbStack CLI helpers. Mirrors the orb_* helpers + the inline
// `orb -m <vm> bash -lc` idiom in services/hermes/{build,start}.sh.
import { $ } from "zx";
import { warn } from "./log.ts";

// Run a bash command inside an orb machine. Returns the captured stdout
// (whitespace-trimmed) — set `stdio: "inherit"` via the second arg for
// long-running commands whose output you want live.
export interface OrbExecOptions {
  stdio?: "inherit" | "pipe";
}

export const orbExec = async (
  vm: string,
  cmd: string,
  opts: OrbExecOptions = {},
): Promise<string> => {
  $.verbose = false;
  if (opts.stdio === "inherit") {
    await $({ verbose: true, stdio: "inherit" })`orb -m ${vm} bash -lc ${cmd}`;
    return "";
  }
  const r = await $`orb -m ${vm} bash -lc ${cmd}`;
  return r.stdout.trim();
};

// Pipe stdin to a remote bash command (writing files, etc).
export const orbExecWithStdin = async (
  vm: string,
  cmd: string,
  stdin: string,
): Promise<string> => {
  $.verbose = false;
  const r = await $({ input: stdin })`orb -m ${vm} bash -lc ${cmd}`;
  return r.stdout.trim();
};

// True if a VM with the exact name `vm` exists in `orb list`.
export const orbMachineExists = async (vm: string): Promise<boolean> => {
  $.verbose = false;
  try {
    const r = await $`orb list`;
    return r.stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0])
      .includes(vm);
  } catch {
    return false;
  }
};

// orb config show + filter for `machine.<vm>.<flag>:` line.
export const orbGetMachineFlag = async (vm: string, flag: string): Promise<string> => {
  $.verbose = false;
  try {
    const r = await $`orb config show`;
    const re = new RegExp(`^machine\\.${vm.replace(/[.*+?^${}()|[\\]/g, "\\$&")}\\.${flag}:\\s*(\\S+)`, "m");
    const m = r.stdout.match(re);
    return m ? m[1] : "";
  } catch {
    return "";
  }
};

// Idempotently flip BOTH isolation flags (isolated + isolate_network) to
// true. Returns 0 if already isolated, 1 if had to flip (restart needed),
// 2 on orb command failure.
export const orbSetMachineIsolation = async (vm: string): Promise<0 | 1 | 2> => {
  let changed = 0;
  for (const flag of ["isolated", "isolate_network"] as const) {
    const cur = await orbGetMachineFlag(vm, flag);
    if (cur === "true") continue;
    try {
      await $`orb config set ${`machine.${vm}.${flag}`} true`;
      changed = 1;
    } catch {
      return 2;
    }
  }
  return changed as 0 | 1;
};

// Read whether the orb-side mount on $VM_HERMES is currently active.
export const orbMountIsActive = async (vm: string, mountPoint: string): Promise<boolean> => {
  try {
    const out = await orbExec(vm, "mount");
    return out.split("\n").some((line) => line.includes(` on ${mountPoint} type`));
  } catch (e) {
    warn(`orbMountIsActive(${vm},${mountPoint}): ${(e as Error).message}`);
    return false;
  }
};
