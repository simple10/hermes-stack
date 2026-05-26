// honcho/build.ts — fetch pinned source + render runtime config.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { STACK_ROOT, STACK_DIR } from "../../scripts/lib/paths.ts";
import { stackSource, consumeRebuildFlag } from "../../scripts/lib/source.ts";
import { loadStackEnv, substituteTemplate } from "../../scripts/lib/stack-env.ts";
import { generatedGenIfMissing } from "../../scripts/lib/generated.ts";
import { dc } from "../../scripts/lib/dc.ts";
import { log } from "../../scripts/lib/log.ts";

export default async function build(): Promise<void> {
  // 1. Pin source.
  await stackSource("honcho");

  // 2. Render config.runtime.toml. The template uses __PLACEHOLDER__ form;
  //    values come from .stack-node/.env (incl. block-owned HONCHO_* keys
  //    that may interpolate ${STACK_LLM_MODEL*} — dotenv-expand resolves
  //    those for us).
  const env = loadStackEnv();
  const tpl = resolve(STACK_ROOT, "services/honcho/config.toml.template");
  const out = resolve(STACK_DIR, "honcho/config.runtime.toml");
  mkdirSync(dirname(out), { recursive: true });
  const fallback = {
    HONCHO_DERIVER_MODEL: "cliproxy/gpt-5.4-mini",
    HONCHO_SUMMARY_MODEL: "cliproxy/gpt-5.4-mini",
    HONCHO_DREAM_MODEL: "cliproxy/gpt-5.4-mini",
    HONCHO_DIALECTIC_MODEL: "cliproxy/gpt-5.5",
    HONCHO_EMBEDDING_MODEL: "voyage-4-lite",
  };
  const body = substituteTemplate(readFileSync(tpl, "utf8"), env, fallback);
  writeFileSync(out, body);
  log(`honcho: rendered config.runtime.toml ` +
    `(deriver=${env.HONCHO_DERIVER_MODEL ?? fallback.HONCHO_DERIVER_MODEL}, ` +
    `dialectic=${env.HONCHO_DIALECTIC_MODEL ?? fallback.HONCHO_DIALECTIC_MODEL}, ` +
    `embed=${env.HONCHO_EMBEDDING_MODEL ?? fallback.HONCHO_EMBEDDING_MODEL})`);

  // 3. Own HONCHO_DB_PASSWORD (decentralized).
  if (generatedGenIfMissing("honcho", "HONCHO_DB_PASSWORD", "", 16)) {
    log("honcho: generated HONCHO_DB_PASSWORD");
  }

  // 4. Eager build when source changed (mirrors the bash version's
  //    "surface the heavy image build at `build` not `start`" rationale).
  if (consumeRebuildFlag("honcho")) {
    log("honcho: source changed — building image (honcho-api + honcho-deriver share one context)");
    const res = await dc(["build", "honcho-api", "honcho-deriver"]);
    if (res.code !== 0) throw new Error("honcho: dc build failed");
  } else {
    log("honcho: source unchanged — skipping dc build");
  }
}
