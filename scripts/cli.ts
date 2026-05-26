// cli.ts — entry point. Tiny dispatcher; commands live in commands/.
//
// Usage:
//   ./stack-cli setup                # interactive .stack-node/.env setup
//   ./stack-cli enable <svc>...      # cascade-enable services
//   ./stack-cli disable <svc>...     # disable (refuses if dependants enabled)
//   ./stack-cli enabled              # list active profiles + machines
//   ./stack-cli build                # render configs, fetch sources, gen secrets
//   ./stack-cli start                # bring up the stack (backends->preflight->up->VMs)
//   ./stack-cli stop                 # bring it down (VMs + dc down)
//   ./stack-cli restart              # stop + start
//   ./stack-cli status               # `dc ps` + `orb list`
//   ./stack-cli logs [machine]       # `orb logs`
//   ./stack-cli reconfigure <svc>    # re-render runtime configs
//   ./stack-cli chrome-cdp           # launch Mac-host Chrome with CDP + bridge
//   ./stack-cli chrome-cdp-stop      # tear them down
//   ./stack-cli start-cleanup        # reap exited provisioner containers
import pc from "picocolors";
import { runSetup } from "./commands/setup.ts";
import { runEnable } from "./commands/enable.ts";
import { runDisable } from "./commands/disable.ts";
import { runEnabled } from "./commands/enabled.ts";
import { runStatus } from "./commands/status.ts";

type Handler = (args: readonly string[]) => Promise<void>;

const COMMANDS: Record<string, Handler> = {
  setup: async () => runSetup(),
  enable: runEnable,
  disable: runDisable,
  enabled: async () => runEnabled(),
  status: async () => runStatus(),
};

const main = async (): Promise<void> => {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === "-h" || cmd === "--help") {
    printHelp();
    return;
  }
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error(pc.red(`unknown command: ${cmd}`));
    printHelp();
    process.exit(2);
  }
  await fn(rest);
};

const printHelp = (): void => {
  console.log(
    [
      pc.bold("stack-cli") + " — parallel Node/TS scripting for hermes-stack",
      "",
      "Commands:",
      "  setup                 interactive .stack-node/.env setup",
      "  enable <svc>...       cascade-enable services",
      "  disable <svc>...      disable (refuses if dependants enabled)",
      "  enabled               list active profiles + machines",
      "  status                dc ps + orb list",
      "",
      pc.dim("Build/start/stop/restart/logs/reconfigure/chrome-cdp coming soon."),
      pc.dim("Operates on .stack-node/ until cutover; the existing `just` flow is untouched."),
    ].join("\n"),
  );
};

main().catch((err) => {
  console.error(pc.red("error:"), err?.stack ?? err);
  process.exit(1);
});
