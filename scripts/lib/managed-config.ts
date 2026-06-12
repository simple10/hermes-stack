// managed-config.ts — merge stack-owned keys into a user-editable YAML config.
//
// For configs that are otherwise USER/DASHBOARD-authoritative (e.g. cliproxy's
// config.yaml, which the management panel rewrites), the stack still owns a few
// invariant keys (secrets, ports, paths). applyManagedKeys sets exactly those
// paths to the stack's current values and leaves everything else — including
// comments and dashboard-added keys — untouched. Generic: callers pass a list
// of {path, value}; adding a managed key is one entry.
import { parseDocument } from 'yaml'

export interface ManagedSpec {
  path: (string | number)[]
  value: unknown
}

export interface ManagedResult {
  yaml: string
  changed: boolean
}

const toJs = (v: unknown): unknown =>
  v != null && typeof (v as { toJSON?: () => unknown }).toJSON === 'function'
    ? (v as { toJSON: () => unknown }).toJSON()
    : v

export const applyManagedKeys = (yamlText: string, specs: ManagedSpec[]): ManagedResult => {
  const doc = parseDocument(yamlText)
  let changed = false
  for (const { path, value } of specs) {
    const current = toJs(doc.getIn(path))
    if (JSON.stringify(current) === JSON.stringify(value)) continue
    doc.setIn(path, value)
    changed = true
  }
  return { yaml: changed ? doc.toString() : yamlText, changed }
}
