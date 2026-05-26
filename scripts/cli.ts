// cli.ts — entry point. Tiny dispatcher; commands live in commands/.
//
// Usage:
//   ./stack-cli setup                # interactive .stack-node/.env setup
//   ./stack-cli enable <svc>...      # cascade-enable services
//   ./stack-cli disable <svc>...     # disable (refuses if dependants enabled)
//   ./stack-cli enabled              # list active profiles + machines
//   ./stack-cli build                # render configs, fetch sources, gen secrets
//   ./stack-cli start                # bring up the stack
//   ./stack-cli stop                 # bring it down (VMs + dc down)
//   ./stack-cli restart              # stop + start
//   ./stack-cli status               # `dc ps` + `orb list`
//   ./stack-cli logs [machine]       # `orb logs`
//   ./stack-cli reconfigure <svc>    # re-render runtime configs
//   ./stack-cli chrome-cdp           # launch Mac-host Chrome with CDP
//   ./stack-cli chrome-cdp-stop      # tear them down
//   ./stack-cli start-cleanup        # reap exited provisioner containers
import pc from "picocolors";
import { runSetup } from "./commands/setup.ts";
import { runEnable } from "./commands/enable.ts";
import { runDisable } from "./commands/disable.ts";
import { runEnabled } from "./commands/enabled.ts";
import { runStatus } from "./commands/status.ts";
import { runBuild } from "./commands/build.ts";
import { runStart } from "./commands/start.ts";
import { runStop } from "./commands/stop.ts";
import { runRestart } from "./commands/restart.ts";
import { runLogs } from "./commands/logs.ts";
import { runReconfigure } from "./commands/reconfigure.ts";
import { runStartCleanup } from "./commands/start-cleanup.ts";
import { runChromeCdp, runChromeCdpStop } from "./commands/chrome-cdp.ts";

type Handler = (args: readonly string[]) => Promise<void>;

const COMMANDS: Record<string, Handler> = {
  setup: async () => runSetup(),
  enable: runEnable,
  disable: runDisable,
  enabled: async () => runEnabled(),
  status: async () => runStatus(),
  build: async () => runBuild(),
  start: async () => runStart(),
  up: async () => runStart(),
  stop: async () => runStop(),
  down: async () => runStop(),
  restart: async () => runRestart(),
  logs: runLogs,
  reconfigure: runReconfigure,
  "start-cleanup": async () => runStartCleanup(),
  "chrome-cdp": async () => runChromeCdp(),
  "chrome-cdp-stop": async () => runChromeCdpStop(),
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
      "  build                 resolve image digests + per-service build.ts",
      "  start (up)            backends -> preflight -> prestart -> up -> poststart -> VMs",
      "  stop  (down)          VMs + dc down --remove-orphans",
      "  restart               stop + start",
      "  status                dc ps + orb list",
      "  logs [machine]        orb logs",
      "  reconfigure <svc>     re-render runtime config(s)",
      "  start-cleanup         remove exited provisioner containers",
      "  chrome-cdp[-stop]     Mac-host Chrome with CDP for the hermes VM",
      "",
      pc.dim("Operates on .stack-node/ until cutover; the existing `just` flow is untouched."),
    ].join("\n"),
  );
};

main().catch((err) => {
  console.error(pc.red("error:"), err?.stack ?? err);
  process.exit(1);
});
