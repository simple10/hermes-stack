// commands/chrome-cdp.ts — launch Mac-host Chrome with CDP + the
// localhost-proxy bridge for the isolated hermes VM, and tear them down.
//
// Stub. ./stack-cli stop calls runChromeCdpStop(loud=false) on every
// teardown so this stays safe-callable; full port is a follow-up.
import { log, warn } from '../lib/log.ts'

export const runChromeCdp = async (): Promise<void> => {
  warn('chrome-cdp: not yet implemented in stack-cli.')
}

export const runChromeCdpStop = async (loud: boolean = true): Promise<void> => {
  if (loud) {
    log('chrome-cdp-stop: not yet implemented in stack-cli (no-op).')
  }
}
