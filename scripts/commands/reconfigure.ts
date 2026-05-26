// commands/reconfigure.ts — back up + re-render a service's runtime
// config from its template. Mirrors `just reconfigure <svc>`.
//
// For services with a known template path, we hardcode the (template,
// output) pair. Extending this list as more services accumulate
// templates is fine; alternatively, a service-side reconfigure.ts
// could own the mapping (TODO).
import { existsSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { STACK_ROOT, STACK_DIR } from "../lib/paths.ts";
import { forceRender } from "../lib/template.ts";
import { die, log } from "../lib/log.ts";

interface Renderable { template: string; output: string }

const renderables = (svc: string): Renderable[] => {
  const T = (rel: string) => resolve(STACK_ROOT, "services", svc, rel);
  const O = (rel: string) => resolve(STACK_DIR, svc, rel);
  switch (svc) {
    case "litellm":      return [{ template: T("config.yaml.template"), output: O("config.runtime.yaml") }];
    case "cliproxyapi":  return [{ template: T("config.yaml.template"), output: O("config.runtime.yaml") }];
    case "honcho":       return [{ template: T("config.toml.template"), output: O("config.runtime.toml") }];
    case "searxng":      return [{ template: T("settings.yml.template"), output: O("settings.yml") }];
    default:             return [];
  }
};

export const runReconfigure = async (args: readonly string[]): Promise<void> => {
  const svc = args[0];
  if (!svc) die("usage: stack-cli reconfigure <svc>");
  const list = renderables(svc);
  if (list.length === 0) die(`reconfigure: '${svc}' has no known templates (or templates aren't wired here yet)`);
  for (const { template, output } of list) {
    if (!existsSync(template)) die(`reconfigure: missing template ${template}`);
    if (existsSync(output)) copyFileSync(output, output + ".bak");
    forceRender(template, output, svc);
    log(`reconfigure: ${output} re-rendered (backup at ${output}.bak)`);
  }
};
