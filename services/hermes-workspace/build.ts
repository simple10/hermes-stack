// hermes-workspace/build.ts — refuse-to-build until the user opens the
// Hermes gateway access gate. Phase 1 image resolution is handled by the
// build orchestrator; this is just the safety check.
import { stackGet } from "../../scripts/lib/stack.ts";
import { die, log } from "../../scripts/lib/log.ts";

export default async function build(): Promise<void> {
  if (stackGet("HERMES_GATEWAY_ALLOW_ACCESS") !== "true") {
    die(
      `hermes-workspace requires HERMES_GATEWAY_ALLOW_ACCESS=true in .stack-node/.env.

  The Hermes gateway defaults to loopback-only inside the VM. To allow
  hermes-workspace to reach it:

    1. edit .stack-node/.env: HERMES_GATEWAY_ALLOW_ACCESS=true
    2. stack-cli setup       # mints HERMES_GATEWAY_API_KEY + HERMES_WORKSPACE_PASSWORD
    3. stack-cli build       # rebuilds the hermes systemd unit + this service
    4. stack-cli start       # drain-restarts the gateway + brings up workspace

  SECURITY: binds the gateway to 0.0.0.0 on the orb docker network.
  HERMES_GATEWAY_API_KEY is required on every inbound request.`,
    );
  }
  log("hermes-workspace: gate open (HERMES_GATEWAY_ALLOW_ACCESS=true)");
}
