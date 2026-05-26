// commands/status.ts — `stack-cli status`. Prints this project's
// container health + `orb list` (if available).
import { $ } from "zx";
import pc from "picocolors";
import { dc } from "../lib/dc.ts";
import { stackProject } from "../lib/compose-env.ts";

export const runStatus = async (): Promise<void> => {
  console.log(pc.bold(`docker compose ps  (project=${stackProject()})`));
  await dc(["ps"]);
  console.log();
  console.log(pc.bold("orb list:"));
  try {
    $.verbose = true;
    await $`orb list`;
  } catch {
    console.log(pc.dim("(orb not on PATH — skipping)"));
  }
};
