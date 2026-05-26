// commands/chrome-cdp.ts — launch Mac-host Chrome with CDP + the
// localhost-proxy bridge for the isolated hermes VM, and tear them down.
//
// Stub for now: forwards to `just chrome-cdp` / `just chrome-cdp-stop`
// so the new orchestrator's stop pipeline works without re-porting the
// Chrome launcher recipe yet.
import { $ } from "zx";
import { log, warn } from "../lib/log.ts";

const tryJust = async (target: string): Promise<boolean> => {
  $.verbose = false;
  try {
    await $`just ${target}`;
    return true;
  } catch {
    return false;
  }
};

export const runChromeCdp = async (): Promise<void> => {
  if (await tryJust("chrome-cdp")) {
    log("chrome-cdp: delegated to `just chrome-cdp` (port TODO)");
  } else {
    warn("chrome-cdp: `just chrome-cdp` failed or `just` not on PATH (TODO: port)");
  }
};

export const runChromeCdpStop = async (loud: boolean = true): Promise<void> => {
  const ok = await tryJust("chrome-cdp-stop");
  if (loud) {
    if (ok) log("chrome-cdp-stop: delegated to `just chrome-cdp-stop` (port TODO)");
    else warn("chrome-cdp-stop: `just chrome-cdp-stop` failed or `just` not on PATH");
  }
};
