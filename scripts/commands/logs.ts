// commands/logs.ts — orb logs <machine>. Default to the first
// STACK_MACHINES entry.
import { $ } from "zx";
import { stackMachines, stackVmName } from "../lib/compose-env.ts";
import { die } from "../lib/log.ts";

export const runLogs = async (args: readonly string[]): Promise<void> => {
  $.verbose = false;
  const machines = stackMachines();
  if (machines.length === 0) die("no VMs enabled (STACK_MACHINES is empty)");
  const svc = args[0] ?? machines[0];
  const vm = stackVmName(svc);
  await $`orb logs ${vm}`.pipe(process.stdout);
};
