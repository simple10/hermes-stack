// svc.ts — common types + helpers for per-service build/preflight/etc.
// modules that live at services/<svc>/<phase>.ts. The orchestrator
// (commands/build.ts, commands/start.ts) dynamically imports these.
//
// Each phase module exports a default async function — no args:
//
//   // services/<svc>/build.ts
//   export default async function build(): Promise<void> { ... }
//
// Phases (mirrors the bash artifacts):
//   build.ts      — `stack-cli build` (no Docker). Render configs, gen
//                   secrets, fetch pinned sources.
//   preflight.ts  — `stack-cli start`, before main `up`. Host script;
//                   may `dc up -d <dep>` + mint keys.
//   prestart.ts   — after preflight. Validate env/config, fail loud.
//   poststart.ts  — after `dc up -d`. Steps needing something serving.
//   start.ts      — VM services only. Bring up the orb machine + agent.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SERVICES_DIR } from './paths.ts'

export type Phase = 'build' | 'preflight' | 'prestart' | 'poststart' | 'start'

export const phasePath = (svc: string, phase: Phase): string =>
  resolve(SERVICES_DIR, svc, `${phase}.ts`)

export const hasPhase = (svc: string, phase: Phase): boolean => existsSync(phasePath(svc, phase))

// Run services/<svc>/<phase>.ts if it exists. Returns true if it ran,
// false if no such file. Re-throws any error from the phase.
export const runPhase = async (svc: string, phase: Phase): Promise<boolean> => {
  const path = phasePath(svc, phase)
  if (!existsSync(path)) return false
  const mod = await import(pathToFileURL(path).href)
  const fn = (mod.default ?? mod.run) as (() => Promise<void>) | undefined
  if (typeof fn !== 'function') {
    throw new Error(`${path}: no default export (expected async function)`)
  }
  await fn()
  return true
}
