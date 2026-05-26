// searxng/build.ts — own SEARXNG_SECRET_KEY (gen-once) + render the
// overlay settings.yml from template. Standalone service — no backend
// deps, no preflight/prestart. Image is tag-class; pulled at `dc up`.
import { readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { STACK_ROOT, STACK_DIR } from "../../scripts/lib/paths.ts";
import { generatedGet, generatedGenIfMissing } from "../../scripts/lib/generated.ts";
import { substituteTemplate } from "../../scripts/lib/stack-env.ts";
import { die, log } from "../../scripts/lib/log.ts";

export default async function build(): Promise<void> {
  if (generatedGenIfMissing("searxng", "SEARXNG_SECRET_KEY", "", 32)) {
    log("searxng: generated SEARXNG_SECRET_KEY");
  } else {
    log("searxng: reusing existing SEARXNG_SECRET_KEY");
  }
  const key = generatedGet("searxng", "SEARXNG_SECRET_KEY");
  if (!key) die("searxng: SEARXNG_SECRET_KEY not present after gen — internal error");

  const tpl = resolve(STACK_ROOT, "services/searxng/settings.yml.template");
  const out = resolve(STACK_DIR, "searxng/settings.yml");
  mkdirSync(dirname(out), { recursive: true });
  const body = substituteTemplate(readFileSync(tpl, "utf8"), { SEARXNG_SECRET_KEY: key });
  writeFileSync(out, body);
  chmodSync(out, 0o600);
  log("searxng: rendered settings.yml (use_default_settings=true + json format)");
}
