// load-bearing.ts — services depended on via compose `condition: service_healthy`.
//
// Their in-container Docker healthcheck is load-bearing: if a version bump
// breaks the probe (e.g. the new image dropped the tool it used), every
// dependent HANGS at startup waiting for `service_healthy`. The update apply
// path warns loudly when it bumps one of these and the probe looks broken.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse as yamlParse } from 'yaml'
import { SERVICES_DIR } from './paths.ts'
import { listServices } from './services.ts'

export const loadBearingServices = (): Set<string> => {
  const out = new Set<string>()
  for (const d of listServices()) {
    const f = resolve(SERVICES_DIR, d.name, 'compose.yaml')
    if (!existsSync(f)) continue
    let doc: { services?: Record<string, { depends_on?: unknown }> }
    try {
      doc = (yamlParse(readFileSync(f, 'utf8')) ?? {}) as typeof doc
    } catch {
      continue
    }
    for (const s of Object.values(doc.services ?? {})) {
      const dep = s?.depends_on
      if (!dep || typeof dep !== 'object') continue
      for (const [name, cond] of Object.entries(dep as Record<string, unknown>)) {
        if (
          cond &&
          typeof cond === 'object' &&
          (cond as { condition?: unknown }).condition === 'service_healthy'
        )
          out.add(name)
      }
    }
  }
  return out
}
