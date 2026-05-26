// services.ts — discover service descriptors from services/*/service.env.
//
// Each service.env may declare:
//   SERVICE_RUNNER=docker|vm       (default docker)
//   SERVICE_PROFILE=<name>         (default = svc dir name)
//   SERVICE_KIND=backend           (substrate; hidden from setup list)
//   SERVICE_DESC="…"
//   SERVICE_REQUIRES=a,b,c         (CSV, transitive)
//   SERVICE_LITELLM_KEY=true|false
//   SERVICE_STACK_ENV='multi-line block to inject into .stack-node/.env'
//
// SERVICE_STACK_ENV is multi-line single-quoted in bash; we extract it
// with a single-quote-aware regex rather than spawning bash. If we ever
// need a value with embedded single quotes we'll cross that bridge later.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { SERVICES_DIR } from "./paths.ts";
import { parseEnv } from "./env.ts";

export interface ServiceDescriptor {
  name: string;
  runner: "docker" | "vm";
  profile: string;
  kind: string;        // "backend" | "" (others reserved)
  desc: string;
  requires: string[];
  litellmKey: boolean;
  stackEnv: string;    // multi-line body (no enclosing quotes)
}

const cache = new Map<string, ServiceDescriptor>();

export const loadService = (name: string): ServiceDescriptor | null => {
  if (cache.has(name)) return cache.get(name)!;
  const f = resolve(SERVICES_DIR, name, "service.env");
  if (!existsSync(f)) return null;
  const raw = readFileSync(f, "utf8");
  const flat = parseEnv(raw);
  const stackEnv = extractStackEnv(raw);
  const runnerStr = (flat.get("SERVICE_RUNNER") ?? "docker").toLowerCase();
  const runner: "docker" | "vm" = runnerStr === "vm" ? "vm" : "docker";
  const desc = unquote(flat.get("SERVICE_DESC") ?? "");
  const requires = csv(flat.get("SERVICE_REQUIRES") ?? "");
  const profile = flat.get("SERVICE_PROFILE") || name;
  const litellmKey = (flat.get("SERVICE_LITELLM_KEY") ?? "").toLowerCase() === "true";
  const kind = (flat.get("SERVICE_KIND") ?? "").toLowerCase();
  const d: ServiceDescriptor = { name, runner, profile, kind, desc, requires, litellmKey, stackEnv };
  cache.set(name, d);
  return d;
};

export const listServices = (): ServiceDescriptor[] => {
  const out: ServiceDescriptor[] = [];
  for (const entry of readdirSync(SERVICES_DIR)) {
    const dir = resolve(SERVICES_DIR, entry);
    if (!statSync(dir).isDirectory()) continue;
    const d = loadService(entry);
    if (d) out.push(d);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
};

// Transitive SERVICE_REQUIRES closure. Cycle-safe (visited set). Returns
// leaf-first order so callers can enable dependencies before consumers.
export const expandRequires = (seed: readonly string[]): string[] => {
  const visited = new Set<string>();
  const order: string[] = [];
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    visited.add(name);
    const d = loadService(name);
    if (!d) return; // tolerate unknown (caller validates)
    for (const r of d.requires) visit(r);
    order.push(name);
  };
  for (const s of seed) visit(s);
  return order;
};

// --- helpers -----------------------------------------------------------

const csv = (s: string): string[] =>
  s.split(",").map((x) => x.trim()).filter((x) => x.length > 0);

const unquote = (s: string): string => {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
};

// Pull the SERVICE_STACK_ENV='...' multi-line single-quoted value out of
// raw service.env content. Returns "" if absent. Doesn't handle escaped
// quotes — none of the current service.env files need them.
const extractStackEnv = (raw: string): string => {
  const m = raw.match(/^SERVICE_STACK_ENV='([\s\S]*?)'\s*$/m);
  return m ? m[1] : "";
};
