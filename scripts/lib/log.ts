// log.ts — thin status/warn/die helpers. Clack owns the user-facing flow;
// these are for non-prompt log lines (e.g. "seeded missing X from defaults").
import pc from "picocolors";

export const log = (msg: string): void => {
  console.log(pc.dim("›"), msg);
};

export const warn = (msg: string): void => {
  console.error(pc.yellow("WARN:"), msg);
};

export const die = (msg: string): never => {
  console.error(pc.red("FATAL:"), msg);
  process.exit(1);
};
