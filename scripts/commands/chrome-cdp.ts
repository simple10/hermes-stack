// commands/chrome-cdp.ts — Mac-host Chrome with CDP + the localhost-proxy
// bridge so the isolated hermes VM can drive it.
//
//   ./stack-cli chrome-cdp        # spawn detached Chrome, add bridge mapping,
//                                 # write BROWSER_CDP_URL into ~/.hermes/.env
//   ./stack-cli chrome-cdp-stop   # reverse all of the above
//
// chrome-cdp-stop is also called (loud=false) by `./stack-cli stop`; in that
// mode it skips the localhost-proxy recreate since `dc down` is about to
// tear everything down anyway.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { STACK_DIR, STACK_ROOT } from '../lib/paths.ts'
import { envUpsert } from '../lib/env.ts'
import { csvAdd, csvRemove, stackGet } from '../lib/stack.ts'
import { stackMachines, stackProject } from '../lib/compose-env.ts'
import { dc } from '../lib/dc.ts'
import { die, log, warn } from '../lib/log.ts'

const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CDP_DIR = resolve(STACK_DIR, 'chrome-cdp')
const PID_FILE = resolve(CDP_DIR, 'chrome.pid')
const USER_DATA_DIR = resolve(CDP_DIR, 'data')

const cdpPort = (): string => stackGet('CHROME_CDP_PORT') || '19298'
const bridgePort = (): string => stackGet('CHROME_CDP_BRIDGE_PORT') || '19299'

const spawnChrome = (port: string): number => {
  if (!existsSync(CHROME_BIN)) {
    die(`Chrome not found at ${CHROME_BIN}. Install Google Chrome and retry.`)
    throw new Error('unreachable')
  }
  mkdirSync(USER_DATA_DIR, { recursive: true })

  // Quiet flags so this isolated profile doesn't pester the user about
  // first-run, sign-in, default-browser, what's-new, etc. on each launch.
  // The user-data-dir is dedicated to chrome-cdp (.stack/chrome-cdp/data/),
  // so none of these affect their real Chrome profile.
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-service-autorun',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-features=ChromeWhatsNewUI,ChromeSigninAutoSignin',
    '--password-store=basic',
    '--use-mock-keychain',
  ]

  const proc = spawn(CHROME_BIN, args, { detached: true, stdio: 'ignore' })
  proc.unref()
  if (!proc.pid) {
    die('chrome-cdp: failed to spawn Chrome')
    throw new Error('unreachable')
  }
  writeFileSync(PID_FILE, String(proc.pid))
  return proc.pid
}

const killChrome = (): boolean => {
  if (!existsSync(PID_FILE)) return false
  const raw = readFileSync(PID_FILE, 'utf8').trim()
  const pid = Number.parseInt(raw, 10)
  let killed = false
  if (Number.isFinite(pid) && pid > 0) {
    try {
      process.kill(pid, 'SIGTERM')
      killed = true
    } catch {
      // Process already gone; that's fine.
    }
  }
  writeFileSync(PID_FILE, '')
  return killed
}

// Upsert (or remove) the single BROWSER_CDP_URL line in ~/.hermes/.env.
// Line-oriented: no marker dependency, so this works whether the file
// has the managed block markers or is a flat key=value file.
const setBrowserCdpUrl = (url: string | null): void => {
  if (!stackMachines().includes('hermes')) return // no hermes -> nothing to do

  const mountEnabled = (stackGet('HERMES_MOUNT_ENABLED') || 'true') === 'true'
  if (!mountEnabled) {
    warn('chrome-cdp: HERMES_MOUNT_ENABLED=false — skipping ~/.hermes/.env edit')
    return
  }

  const mountDir = stackGet('HERMES_MOUNT_DIR') || '.stack/hermes/.hermes'
  const macHermes = mountDir.startsWith('/') ? mountDir : resolve(STACK_ROOT, mountDir)
  const envFile = resolve(macHermes, '.env')

  if (url) {
    // envUpsert creates the parent dir + chmod 600. Safe to call even
    // when the file is missing (rare — usually `./stack-cli build`
    // wrote one already).
    envUpsert(envFile, 'BROWSER_CDP_URL', url)
    return
  }

  // Removing: only touch the file if it exists.
  if (!existsSync(envFile)) return
  const body = readFileSync(envFile, 'utf8')
  const next = body.replace(/^BROWSER_CDP_URL=.*\n?/m, '')
  if (next !== body) writeFileSync(envFile, next)
}

const localhostProxyEnabled = (): boolean => {
  const profiles = (stackGet('COMPOSE_PROFILES') || '').split(',').map((s) => s.trim())
  return profiles.includes('localhost-proxy')
}

export const runChromeCdp = async (): Promise<void> => {
  if (!localhostProxyEnabled()) {
    die('chrome-cdp: localhost-proxy is not enabled (./stack-cli enable localhost-proxy)')
  }
  mkdirSync(CDP_DIR, { recursive: true })
  const port = cdpPort()
  const bridge = bridgePort()
  const project = stackProject()

  log(`chrome-cdp: starting Chrome on 127.0.0.1:${port} (user-data-dir=${USER_DATA_DIR})`)
  const pid = spawnChrome(port)
  log(`chrome-cdp: Chrome detached (pid ${pid})`)

  csvAdd('LOCALHOST_PROXY_PORTS', `${bridge}:${port}`)
  log(`chrome-cdp: LOCALHOST_PROXY_PORTS += ${bridge}:${port}`)

  // Force-recreate so the container re-reads its env (LOCALHOST_PROXY_PORTS).
  const r = await dc(['up', '-d', '--force-recreate', 'localhost-proxy'])
  if (r.code !== 0) warn('chrome-cdp: localhost-proxy up/recreate returned non-zero')

  const url = `http://localhost-proxy.${project}.orb.local:${bridge}`
  setBrowserCdpUrl(url)
  log(`chrome-cdp: BROWSER_CDP_URL = ${url}`)
  if (stackMachines().includes('hermes')) {
    log('chrome-cdp: restart hermes to pick up BROWSER_CDP_URL (./stack-cli restart)')
  }
}

export const runChromeCdpStop = async (loud: boolean = true): Promise<void> => {
  const port = cdpPort()
  const bridge = bridgePort()

  if (loud) log('chrome-cdp-stop: tearing down bridge + killing Chrome')

  const killed = killChrome()
  if (loud)
    log(
      killed
        ? `chrome-cdp-stop: Chrome killed`
        : 'chrome-cdp-stop: no Chrome pid found (already stopped)',
    )

  // csvRemove is safe even when the entry isn't present; just routes through
  // stack-upsert which dies if the localhost-proxy block isn't enabled. Guard.
  if (localhostProxyEnabled()) {
    csvRemove('LOCALHOST_PROXY_PORTS', `${bridge}:${port}`)
    if (loud) log(`chrome-cdp-stop: LOCALHOST_PROXY_PORTS -= ${bridge}:${port}`)
  }

  // Only recreate localhost-proxy when called interactively. The
  // `./stack-cli stop` path calls runChromeCdpStop(false), then does its own
  // `dc down --remove-orphans` immediately after — re-upping a container only
  // to tear it down would be noisy and racy.
  if (loud && localhostProxyEnabled()) {
    const r = await dc(['up', '-d', '--force-recreate', 'localhost-proxy'])
    if (r.code !== 0) warn('chrome-cdp-stop: localhost-proxy recreate returned non-zero')
  }

  setBrowserCdpUrl(null)
  if (loud) log('chrome-cdp-stop: BROWSER_CDP_URL removed from hermes managed env')
}
