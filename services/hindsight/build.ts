// hindsight/build.ts — own HINDSIGHT_DB_PASSWORD (decentralized).
// Hindsight is a prebuilt image; password ownership is the only
// build-time concern.
import { generatedGenIfMissing } from "../../scripts/lib/generated.ts";
import { log } from "../../scripts/lib/log.ts";

export default async function build(): Promise<void> {
  if (generatedGenIfMissing("hindsight", "HINDSIGHT_DB_PASSWORD", "", 16)) {
    log("hindsight: generated HINDSIGHT_DB_PASSWORD");
  } else {
    log("hindsight: HINDSIGHT_DB_PASSWORD owned in hindsight.generated.env");
  }
}
