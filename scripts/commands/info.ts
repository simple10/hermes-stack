// commands/info.ts — friendly overview: what's enabled, what's running.
//
// Rendered through clack so the output stays readable in narrow terminals
// (left-gutter framing, no fixed-width tables that overflow).
import * as p from "@clack/prompts";
import pc from "picocolors";
import { envGet } from "../lib/env.ts";
import { STACK_ENV } from "../lib/paths.ts";
import { stackProject } from "../lib/compose-env.ts";
import { getStackHealth, summarize } from "../lib/health.ts";
import { formatServiceLines, formatMachineLines } from "../lib/render-health.ts";

export const runInfo = async (): Promise<void> => {
  const project = stackProject();
  const profiles = envGet(STACK_ENV, "COMPOSE_PROFILES")
    .split(",").map((x) => x.trim()).filter(Boolean);
  const machines = envGet(STACK_ENV, "STACK_MACHINES")
    .split(",").map((x) => x.trim()).filter(Boolean);

  p.intro(pc.bgCyan(pc.black(` ${project} `)));

  p.log.message([
    pc.bold("Enabled"),
    `  Docker (${profiles.length})${profiles.length ? ":" : ""} ${pc.cyan(profiles.join(", ")) || pc.dim("(none)")}`,
    `  VMs    (${machines.length})${machines.length ? ":" : ""} ${pc.cyan(machines.join(", ")) || pc.dim("(none)")}`,
  ].join("\n"));

  const h = await getStackHealth();
  const s = summarize(h);

  p.log.message([
    pc.bold("Services"),
    ...formatServiceLines(h.services).map((l) => "  " + l),
  ].join("\n"));

  p.log.message([
    pc.bold("VMs"),
    ...formatMachineLines(h.machines).map((l) => "  " + l),
  ].join("\n"));

  const allUp = s.upServices === s.totalServices && s.runningMachines === s.totalMachines && s.totalServices > 0;
  const summary = `${s.healthyServices}/${s.totalServices} healthy · ${s.runningMachines}/${s.totalMachines} VM running`;
  if (allUp && s.healthyServices === s.totalServices) {
    p.outro(pc.green("✓ stack up · ") + summary);
  } else if (s.upServices === 0 && s.runningMachines === 0) {
    p.outro(pc.dim("stack is down · ") + summary);
  } else {
    p.outro(pc.yellow("partial · ") + summary);
  }
};
