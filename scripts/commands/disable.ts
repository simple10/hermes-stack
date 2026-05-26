// commands/disable.ts — `stack-cli disable <svc> [<svc>...]`
//
// Refuses (process.exit 1) if any enabled service has SERVICE_REQUIRES
// containing this one. No force flag.
import pc from "picocolors";
import { disableService } from "../lib/stack.ts";
import { renderCompose } from "../lib/compose.ts";
import { die } from "../lib/log.ts";

export const runDisable = async (args: readonly string[]): Promise<void> => {
  if (args.length === 0) die("usage: stack-cli disable <svc> [<svc>...]");
  for (const svc of args) {
    const { changed } = disableService(svc);
    console.log(changed ? pc.cyan(`✓ disabled ${svc}`) : pc.dim(`${svc} already disabled`));
  }
  renderCompose();
};
