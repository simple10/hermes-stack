// commands/start.ts — bring up the stack.
//
// Pipeline (mirrors `just start`):
//   1. ensure docker-compose.yaml is fresh (renderCompose)
//   2. dc up -d $(stackBackends)         — pg/redis/rabbitmq first
//   3. each enabled service's preflight.ts (host script; may dc up,
//      mint keys, etc.)
//   4. each enabled service's prestart.ts (fail-loud validation)
//   5. dc up -d                          — everything else, in-tree
//      provisioners run via Compose depends_on
//   6. each enabled service's poststart.ts (currently rare)
//   7. each STACK_MACHINES service's start.ts (VM bring-up)
//   8. start-cleanup (reap exited provisioners) when
//      STACK_AUTO_REMOVE_PROVISIONERS=true
import pc from "picocolors";
import { renderCompose } from "../lib/compose.ts";
import { dc } from "../lib/dc.ts";
import { stackBackends, stackProfiles, stackMachines, stackProject } from "../lib/compose-env.ts";
import { hasPhase, runPhase } from "../lib/svc.ts";
import { envGet } from "../lib/env.ts";
import { STACK_ENV } from "../lib/paths.ts";
import { runStartCleanup } from "./start-cleanup.ts";
import { die, log } from "../lib/log.ts";

export const runStart = async (): Promise<void> => {
  renderCompose();
  const profiles = stackProfiles().split(",").map((x) => x.trim()).filter(Boolean);
  if (profiles.length === 0 && stackMachines().length === 0) {
    die("nothing enabled — run: stack-cli enable <svc>");
  }

  const backends = stackBackends();
  if (backends.length > 0) {
    console.log(pc.bold(`1. backends: dc up -d ${backends.join(" ")}`));
    const r = await dc(["up", "-d", ...backends]);
    if (r.code !== 0) die("backend bring-up failed");
  }

  console.log(pc.bold("\n2. preflight"));
  for (const svc of profiles) {
    if (!hasPhase(svc, "preflight")) continue;
    console.log(pc.cyan(`→ ${svc}/preflight.ts`));
    await runPhase(svc, "preflight");
  }

  console.log(pc.bold("\n3. prestart"));
  for (const svc of profiles) {
    if (!hasPhase(svc, "prestart")) continue;
    console.log(pc.cyan(`→ ${svc}/prestart.ts`));
    await runPhase(svc, "prestart");
  }

  console.log(pc.bold(`\n4. dc up -d  (project=${stackProject()})`));
  const up = await dc(["up", "-d"]);
  if (up.code !== 0) die("dc up -d failed");

  console.log(pc.bold("\n5. poststart"));
  for (const svc of profiles) {
    if (!hasPhase(svc, "poststart")) continue;
    console.log(pc.cyan(`→ ${svc}/poststart.ts`));
    await runPhase(svc, "poststart");
  }

  const machines = stackMachines();
  if (machines.length > 0) {
    console.log(pc.bold("\n6. VM start"));
    for (const svc of machines) {
      if (!hasPhase(svc, "start")) {
        console.log(pc.dim(`  · ${svc} — no start.ts (skip)`));
        continue;
      }
      console.log(pc.cyan(`→ ${svc}/start.ts`));
      await runPhase(svc, "start");
    }
  }

  if (envGet(STACK_ENV, "STACK_AUTO_REMOVE_PROVISIONERS") === "true") {
    console.log(pc.bold("\n7. start-cleanup"));
    await runStartCleanup();
  } else {
    log("STACK_AUTO_REMOVE_PROVISIONERS=false — leaving exited provisioner containers (rm them with: stack-cli start-cleanup)");
  }
  console.log(pc.green("\nstart done."));
};
