// commands/chrome-cdp.ts — launch Mac-host Chrome with CDP + the
// localhost-proxy bridge for the isolated hermes VM, and tear them down.
//
// NOT YET PORTED to ./stack-cli. The bash recipes (in the legacy
// justfile) still own this surface; this stub is a placeholder so the
// dispatcher table has an entry and `./stack-cli stop` can call
// runChromeCdpStop(loud=false) without blowing up when chrome-cdp
// isn't running.
import { log, warn } from '../lib/log.ts'

export const runChromeCdp = async (): Promise<void> => {
  warn(
    'chrome-cdp: not yet ported to ./stack-cli. ' +
      'Run the chrome-cdp recipe from the legacy bash flow if you need it.',
  )
}

export const runChromeCdpStop = async (loud: boolean = true): Promise<void> => {
  if (loud) {
    log('chrome-cdp-stop: not yet ported to ./stack-cli (no-op).')
  }
}
