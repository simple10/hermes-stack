// commands/restart.ts — stop + start. The PRIMARY way to apply
// orb-machine config changes (mounts, isolation flags) — those only
// take effect on the next `orb start`.
import { runStop } from "./stop.ts";
import { runStart } from "./start.ts";

export const runRestart = async (): Promise<void> => {
  await runStop();
  await runStart();
};
