// firecrawl/build.ts — own FIRECRAWL_DB_PASSWORD + FIRECRAWL_BULL_AUTH_KEY
// (decentralized). Firecrawl is all-env (no config template).
import { generatedGenIfMissing } from "../../scripts/lib/generated.ts";
import { log } from "../../scripts/lib/log.ts";

export default async function build(): Promise<void> {
  generatedGenIfMissing("firecrawl", "FIRECRAWL_DB_PASSWORD", "", 16);
  generatedGenIfMissing("firecrawl", "FIRECRAWL_BULL_AUTH_KEY", "", 16);
  log("firecrawl: FIRECRAWL_DB_PASSWORD + FIRECRAWL_BULL_AUTH_KEY owned in firecrawl.generated.env");
}
