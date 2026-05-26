// services/hermes/start.ts — enable + (re)start hermes units inside the
// VM. Re-applies the virtual key in case it was re-minted (idempotent).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { STACK_ROOT } from "../../scripts/lib/paths.ts";
import { stackProject, stackVmName } from "../../scripts/lib/compose-env.ts";
import { stackGet } from "../../scripts/lib/stack.ts";
import { generatedGet } from "../../scripts/lib/generated.ts";
import { orbExec } from "../../scripts/lib/orb.ts";
import { log, die } from "../../scripts/lib/log.ts";

const SVC = "hermes";
const D = resolve(STACK_ROOT, "services/hermes");

const subst = (body: string, vars: Record<string, string>): string =>
  body.replace(/__([A-Z][A-Z0-9_]*)__/g, (_, k) => vars[k] ?? "")
      .replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, k) => vars[k] ?? `\${${k}}`);

export default async function start(): Promise<void> {
  if (SVC === ("hermes-agent" as string)) die("REFUSING: 'hermes-agent' is the frozen original.");
  const vm = stackVmName(SVC);
  const project = stackProject();
  const hk = generatedGet("litellm", "HERMES_VIRTUAL_KEY");
  const hm = stackGet("HERMES_MODEL") || "cliproxy/gpt-5.5";
  const mountEnabled = (stackGet("HERMES_MOUNT_ENABLED") || "true") === "true";
  const remoteUser = stackGet("HERMES_REMOTE_USER") || "hermes";
  const mountDir = stackGet("HERMES_MOUNT_DIR") || ".stack-node/hermes/.hermes";
  const macHermes = mountDir.startsWith("/") ? mountDir : resolve(STACK_ROOT, mountDir);

  if (hk) {
    const tpl = readFileSync(resolve(D, "config/config.yaml.model.tmpl"), "utf8");
    const modelBlock = subst(tpl, { STACK_PROJECT: project, HERMES_MODEL: hm, HERMES_VIRTUAL_KEY: hk })
      .split("\n").filter((l) => !l.startsWith("#")).join("\n");
    if (mountEnabled) {
      const cfg = resolve(macHermes, "config.yaml");
      const body = existsSync(cfg) ? readFileSync(cfg, "utf8") : "";
      const lines = body.split("\n");
      const out: string[] = [];
      let replaced = false;
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        if (ln.trimEnd() === "model:" || ln.startsWith("model:")) {
          i++;
          while (i < lines.length && (lines[i].startsWith(" ") || lines[i].trim() === "")) i++;
          i--;
          out.push(modelBlock.trimEnd());
          replaced = true;
          continue;
        }
        out.push(ln);
      }
      if (!replaced) out.unshift(modelBlock.trimEnd());
      writeFileSync(cfg, out.join("\n").replace(/\n*$/, "") + "\n");
      log("hermes/start: re-applied model: block with current HERMES_VIRTUAL_KEY (Mac-side)");
    } else {
      log("hermes/start: model: block reapply skipped (mount disabled)");
    }
  }

  // Suppress unused warning for remoteUser — present here for parity with
  // bash; future homedir-driven config writes may need it.
  void remoteUser;

  await orbExec(vm, [
    "set -e",
    "sudo systemctl daemon-reload",
    "sudo systemctl enable --now hermes-dashboard hermes-gateway hermes-logtail",
    "sudo systemctl restart hermes-logtail",
    "sudo hermes gateway restart --system",
  ].join(" && "), { stdio: "inherit" });

  const active = await orbExec(vm, 'systemctl is-active hermes-dashboard hermes-gateway hermes-logtail | tr "\\n" " "');
  log(`services: ${active}`);
  try {
    const out = await orbExec(vm, `curl -sS -m6 http://honcho-api.${project}.orb.local:8000/health || true`);
    log(`honcho reachable: ${out}`);
  } catch { /* honcho not running */ }
}
