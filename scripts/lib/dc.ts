// dc.ts — hermetic `docker compose` runner for the parallel test stack.
//
// Mirrors dc() in lib/stacklib.sh:
//   - Project name + profiles injected from .stack-node/.env (never the
//     ambient shell).
//   - --env-file args for .stack-node/.env + every .stack-node/*/.generated.env
//     (absolute paths).
//   - Host environment STRIPPED apart from a tight docker-operational
//     allowlist (PATH, HOME, DOCKER_*, *_PROXY, etc.). Compose interpolation
//     precedence is host-env > --env-file, so a stray exported POSTGRES_SUPERPASS
//     or COMPOSE_PROFILES would silently outrank the real value otherwise.
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { STACK_DIR, STACK_ENV } from './paths.ts'
import { COMPOSE_PATH, renderCompose } from './compose.ts'
import { stackProject, stackProfiles } from './compose-env.ts'

const HOST_ALLOWLIST = [
  // operational (talking to the daemon, building over the network)
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TERM',
  'TMPDIR',
  'TZ',
  'LANG',
  'LC_ALL',
  'SSH_AUTH_SOCK',
  'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'FTP_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'ftp_proxy',
  'all_proxy',
  'no_proxy',
]

const generatedEnvFiles = (): string[] => {
  if (!existsSync(STACK_DIR)) return []
  const out: string[] = []
  for (const sub of readdirSync(STACK_DIR)) {
    const dir = resolve(STACK_DIR, sub)
    if (!statSync(dir).isDirectory()) continue
    const f = resolve(dir, '.generated.env')
    if (existsSync(f)) out.push(f)
  }
  return out.sort()
}

export const dcArgs = (extra: readonly string[]): string[] => {
  if (!existsSync(COMPOSE_PATH)) renderCompose()
  const args = ['-p', stackProject(), '-f', COMPOSE_PATH, '--env-file', STACK_ENV]
  for (const f of generatedEnvFiles()) args.push('--env-file', f)
  return [...args, ...extra]
}

export const dcEnv = (): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const k of HOST_ALLOWLIST) {
    const v = process.env[k]
    if (typeof v === 'string') env[k] = v
  }
  const prof = stackProfiles()
  if (prof) env.COMPOSE_PROFILES = prof
  return env
}

export interface DcOptions {
  stdio?: 'inherit' | 'pipe'
  cwd?: string
}

export interface DcResult {
  code: number
  stdout: string
  stderr: string
}

// dc(...args) — spawn `docker compose <args>` with hermetic env. Returns
// the spawn promise. Default stdio is inherit (interactive).
export const dc = (args: readonly string[], opts: DcOptions = {}): Promise<DcResult> => {
  const stdio = opts.stdio ?? 'inherit'
  const full = ['compose', ...dcArgs(args)]
  return new Promise((resolveP, rejectP) => {
    const proc = spawn('docker', full, {
      stdio,
      env: dcEnv(),
      cwd: opts.cwd,
    })
    let stdout = ''
    let stderr = ''
    if (stdio === 'pipe') {
      proc.stdout?.on('data', (c) => {
        stdout += c.toString()
      })
      proc.stderr?.on('data', (c) => {
        stderr += c.toString()
      })
    }
    proc.on('error', rejectP)
    proc.on('close', (code) => resolveP({ code: code ?? 0, stdout, stderr }))
  })
}

// dcCapture — convenience: pipe stdio, return DcResult. Throws on non-zero.
export const dcCapture = async (args: readonly string[]): Promise<DcResult> => {
  const r = await dc(args, { stdio: 'pipe' })
  if (r.code !== 0) {
    throw new Error(`docker compose ${args.join(' ')} failed (${r.code})\n${r.stderr}`)
  }
  return r
}
