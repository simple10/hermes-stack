// honcho-ui/build.ts — fetch pinned OpenConcho source, then build the
// image so the per-project default-endpoint patch (HONCHO_BASE_URL build
// arg) is baked deterministically (multi-stack safe).
import { stackSource, consumeRebuildFlag } from "../../scripts/lib/source.ts";
import { dc } from "../../scripts/lib/dc.ts";
import { stackProject } from "../../scripts/lib/compose-env.ts";
import { log } from "../../scripts/lib/log.ts";

export default async function build(): Promise<void> {
  await stackSource("honcho-ui");
  if (consumeRebuildFlag("honcho-ui")) {
    log(
      `honcho-ui: source changed — building image ` +
      `(default endpoint -> http://honcho-api.${stackProject()}.orb.local:8000)`,
    );
    const r = await dc(["build", "honcho-ui"]);
    if (r.code !== 0) throw new Error("honcho-ui: dc build failed");
  } else {
    log("honcho-ui: source unchanged — skipping dc build");
  }
}
