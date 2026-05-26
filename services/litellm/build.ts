// litellm/build.ts — render runtime config from template; own
// LITELLM_DB_PASSWORD (decentralized; never blind-regen).
import { resolve } from "node:path";
import { STACK_ROOT } from "../../scripts/lib/paths.ts";
import { renderTemplate } from "../../scripts/lib/template.ts";
import { generatedGenIfMissing } from "../../scripts/lib/generated.ts";
import { STACK_DIR } from "../../scripts/lib/paths.ts";
import { log } from "../../scripts/lib/log.ts";

export default async function build(): Promise<void> {
  const src = resolve(STACK_ROOT, "services/litellm/config.yaml.template");
  const dst = resolve(STACK_DIR, "litellm/config.runtime.yaml");
  renderTemplate(src, dst, "litellm");
  if (generatedGenIfMissing("litellm", "LITELLM_DB_PASSWORD", "", 16)) {
    log("litellm: LITELLM_DB_PASSWORD generated");
  } else {
    log("litellm: LITELLM_DB_PASSWORD owned in litellm.generated.env (reused)");
  }
}
