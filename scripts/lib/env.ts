// env.ts — `.env`-style file read/write (mirrors stacklib.sh's
// env_get / env_upsert behaviour). Line-oriented; preserves the position
// of each KEY (replacement is in-place, never reshuffles to the bottom —
// the old shell version got that wrong and lost track of COMPOSE_PROFILES
// between block markers).
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

export const readEnv = (file: string): string => {
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf8");
};

export const envGet = (file: string, key: string): string => {
  const body = readEnv(file);
  if (!body) return "";
  const m = body.match(new RegExp(`^${escapeRe(key)}=(.*)$`, "m"));
  return m ? m[1] : "";
};

export const envUpsert = (file: string, key: string, value: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  const body = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lineRe = new RegExp(`^${escapeRe(key)}=.*$`, "m");
  let next: string;
  if (lineRe.test(body)) {
    next = body.replace(lineRe, `${key}=${value}`);
  } else {
    next = body.length === 0 || body.endsWith("\n") ? body : body + "\n";
    next += `${key}=${value}\n`;
  }
  writeFileSync(file, next);
  chmodSync(file, 0o600);
};

// Parse every `KEY=VAL` line out of a body. Strips inline `# comment` from
// values and trims surrounding whitespace — matches stacklib.sh's
// _env_value semantics for declaration-style files (service.env,
// .stack.defaults.env).
export const parseEnv = (body: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1);
    const hashIdx = val.indexOf("#");
    if (hashIdx >= 0) val = val.slice(0, hashIdx);
    out.set(key, val.trim());
  }
  return out;
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
