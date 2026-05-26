// cliproxyapi/build.ts — render config.yaml.template -> config.runtime.yaml
// with the two secrets injected from .stack-node/.env. CLIProxyAPI has no
// env-var config support, so the rendered runtime file carries the keys
// (gitignored under .stack-node/).
import { readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { STACK_ROOT, STACK_DIR } from "../../scripts/lib/paths.ts";
import { stackGet } from "../../scripts/lib/stack.ts";
import { substituteTemplate } from "../../scripts/lib/stack-env.ts";
import { die, log } from "../../scripts/lib/log.ts";

export default async function build(): Promise<void> {
  const apiKey = stackGet("CLIPROXY_API_KEY");
  const mgmtKey = stackGet("CLIPROXY_MANAGEMENT_KEY");
  if (!apiKey) die("CLIPROXY_API_KEY missing in .stack-node/.env (run: stack-cli setup)");
  if (!mgmtKey) die("CLIPROXY_MANAGEMENT_KEY missing in .stack-node/.env (run: stack-cli setup)");
  const tpl = resolve(STACK_ROOT, "services/cliproxyapi/config.yaml.template");
  const out = resolve(STACK_DIR, "cliproxyapi/config.runtime.yaml");
  mkdirSync(dirname(out), { recursive: true });
  const body = substituteTemplate(readFileSync(tpl, "utf8"), {
    CLIPROXY_API_KEY: apiKey,
    CLIPROXY_MGMT_KEY: mgmtKey,
  });
  writeFileSync(out, body);
  chmodSync(out, 0o600);
  log("cliproxyapi: rendered config.runtime.yaml (secrets injected from .stack-node/.env)");
}
