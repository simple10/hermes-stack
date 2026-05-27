// orb.ts — OrbStack CLI helpers.
//
// HTTP_PROXY scrubbing: OrbStack passes the calling process's
// HTTP_PROXY/HTTPS_PROXY env vars into the VM shell, rewriting 127.0.0.1
// to `host.orb.internal`. Combined with `--isolate-network` (which blocks
// Mac IPs from the VM) this turns into curl-(7) for every install script
// the VM tries to run. The PMG package-manager wrapper sets HTTP_PROXY on
// the parent shell, so we have to strip it on every orb call.
import { spawn } from 'node:child_process'
import { $ } from 'zx'
import { warn } from './log.ts'

export const orbEnv = (): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue
    if (/^(https?_proxy|all_proxy|no_proxy|pip_proxy|node_use_env_proxy)$/i.test(k)) continue
    out[k] = v
  }
  return out
}

const orb$ = $({ env: orbEnv(), verbose: false })
const orb$inherit = $({ env: orbEnv(), verbose: true, stdio: 'inherit' })

// Run a bash command inside an orb machine. Returns the captured stdout
// (whitespace-trimmed) — set `stdio: "inherit"` via the second arg for
// long-running commands whose output you want live.
export interface OrbExecOptions {
  stdio?: 'inherit' | 'pipe'
}

export const orbExec = async (
  vm: string,
  cmd: string,
  opts: OrbExecOptions = {},
): Promise<string> => {
  if (opts.stdio === 'inherit') {
    await orb$inherit`orb -m ${vm} bash -lc ${cmd}`
    return ''
  }
  const r = await orb$`orb -m ${vm} bash -lc ${cmd}`
  return r.stdout.trim()
}

// Pipe stdin to a remote bash command (writing files, etc).
export const orbExecWithStdin = async (vm: string, cmd: string, stdin: string): Promise<string> => {
  const $in = $({ env: orbEnv(), input: stdin, verbose: false })
  const r = await $in`orb -m ${vm} bash -lc ${cmd}`
  return r.stdout.trim()
}

// True if a VM with the exact name `vm` exists in `orb list`.
export const orbMachineExists = async (vm: string): Promise<boolean> => {
  try {
    const r = await orb$`orb list`
    return r.stdout
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[0])
      .includes(vm)
  } catch {
    return false
  }
}

// orb config show + filter for `machine.<vm>.<flag>:` line.
export const orbGetMachineFlag = async (vm: string, flag: string): Promise<string> => {
  try {
    const r = await orb$`orb config show`
    const re = new RegExp(
      `^machine\\.${vm.replace(/[.*+?^${}()|[\\]/g, '\\$&')}\\.${flag}:\\s*(\\S+)`,
      'm',
    )
    const m = r.stdout.match(re)
    return m ? m[1] : ''
  } catch {
    return ''
  }
}

// Idempotently flip BOTH isolation flags (isolated + isolate_network) to
// true. Returns 0 if already isolated, 1 if had to flip (restart needed),
// 2 on orb command failure.
export const orbSetMachineIsolation = async (vm: string): Promise<0 | 1 | 2> => {
  let changed = 0
  for (const flag of ['isolated', 'isolate_network'] as const) {
    const cur = await orbGetMachineFlag(vm, flag)
    if (cur === 'true') continue
    try {
      await orb$`orb config set ${`machine.${vm}.${flag}`} true`
      changed = 1
    } catch {
      return 2
    }
  }
  return changed as 0 | 1
}

// Read whether the orb-side mount on $VM_HERMES is currently active.
export const orbMountIsActive = async (vm: string, mountPoint: string): Promise<boolean> => {
  try {
    const out = await orbExec(vm, 'mount')
    return out.split('\n').some((line) => line.includes(` on ${mountPoint} type`))
  } catch (e) {
    warn(`orbMountIsActive(${vm},${mountPoint}): ${(e as Error).message}`)
    return false
  }
}

// Spawn `orb` with the same proxy-scrubbed env — exposed for callers
// (e.g. hermes/build.ts) that build their own `$\`orb ...\`` invocations.
export const orbShell = orb$

// Run `orb -m <vm> [args...]` with full TTY pass-through (inherit
// stdio so the user can type, see colors, etc). For interactive
// shells, hermes-cli sessions, anything that wants a real terminal.
// Resolves regardless of exit code — Ctrl-D / exit shouldn't be an
// error.
export const orbInteractive = (vm: string, args: readonly string[] = []): Promise<void> =>
  new Promise((resolve, reject) => {
    const proc = spawn('orb', ['-m', vm, ...args], {
      stdio: 'inherit',
      env: orbEnv(),
    })
    proc.on('error', reject)
    proc.on('close', () => resolve())
  })
