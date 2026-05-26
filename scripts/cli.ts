// cli.ts — entry point. Tiny dispatcher; commands live in commands/.
//
// Usage:
//   ./stack-cli setup     # interactive .stack-node/.env setup
//   ./stack-cli <cmd>     # future: enable / disable / enabled / build / start
import pc from "picocolors";
import { runSetup } from "./commands/setup.ts";

const COMMANDS: Record<string, () => Promise<void>> = {
  setup: runSetup,
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
  if (rest.length > 0) {
    console.error(pc.yellow(`note: extra args ignored for now: ${rest.join(" ")}`));
  }
  await fn();
};

const printHelp = (): void => {
  console.log(
    [
      pc.bold("stack-cli") + " — parallel Node/TS scripting for hermes-stack",
      "",
      "Commands:",
      "  setup     interactive .stack-node/.env setup",
      "",
      pc.dim("Operates on .stack-node/ until cutover; the existing `just` flow is untouched."),
    ].join("\n"),
  );
};

main().catch((err) => {
  console.error(pc.red("error:"), err?.stack ?? err);
  process.exit(1);
});
