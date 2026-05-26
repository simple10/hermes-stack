// source.ts — port of stack_source in lib/stacklib.sh.
//
// Clone-and-pin services/<svc>/_source to ${<SVC_UC>_VERSION:-DEFAULT_PIN}.
// State (lock + rebuild flag) lives in .stack-node/<svc>/.generated.env
// under <SVC_UC>_SOURCE_* keys.
//
// Reuse fast-path: lock matches + HEAD matches -> no network, no rebuild flag.
// Otherwise: fetch tags + the requested ref, resolve to a commit SHA,
// checkout --detach, set the rebuild flag.
import { $ } from "zx";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { STACK_ROOT } from "./paths.ts";
import { generatedGet, generatedUpsert } from "./generated.ts";
import { loadService } from "./services.ts";
import { parseEnvFile } from "./env.ts";
import { stackGet } from "./stack.ts";
import { die, log } from "./log.ts";

const svcUc = (svc: string): string => svc.toUpperCase().replace(/-/g, "_");

export interface SourceResult {
  reused: boolean;
  sha: string;
  requested: string;
}

export const ensureDockerignore = (srcDir: string): void => {
  const f = resolve(srcDir, ".dockerignore");
  if (!existsSync(f)) {
    writeFileSync(f, ".git/\n");
    return;
  }
  const body = readFileSync(f, "utf8");
  const lines = body.split("\n").map((s) => s.trim());
  if (lines.includes(".git/")) return;
  writeFileSync(f, (body.endsWith("\n") ? body : body + "\n") + ".git/\n");
};

export const stackSource = async (
  svc: string,
  repoArg?: string,
  defaultPinArg?: string,
): Promise<SourceResult> => {
  $.verbose = false;
  const d = loadService(svc);
  if (!d) {
    die(`stackSource(${svc}): service.env not found`);
    throw new Error("unreachable");
  }
  const uc = svcUc(svc);
  const flat = parseEnvFile(resolve(STACK_ROOT, "services", svc, "service.env"));
  const repo = repoArg ?? flat[`${uc}_SOURCE_REPO`];
  const defaultPin = defaultPinArg ?? flat[`${uc}_SOURCE_DEFAULT`];
  if (!repo) {
    die(`stackSource(${svc}): no ${uc}_SOURCE_REPO in service.env`);
    throw new Error("unreachable");
  }
  if (!defaultPin) {
    die(`stackSource(${svc}): no ${uc}_SOURCE_DEFAULT in service.env`);
    throw new Error("unreachable");
  }
  // Override precedence mirrors bash ${VAR:-default}: stack-env wins over
  // ambient process.env (which is mostly stripped by dc()'s allowlist
  // anyway, but build runs OUTSIDE dc, so we still defend against it).
  const requested = stackGet(`${uc}_VERSION`) || process.env[`${uc}_VERSION`] || defaultPin;
  const srcDir = resolve(STACK_ROOT, "services", svc, "_source");

  if (existsSync(resolve(srcDir, ".git"))) {
    let originUrl = "";
    try {
      originUrl = (await $`git -C ${srcDir} remote get-url origin`).stdout.trim();
    } catch { /* no origin yet */ }
    if (originUrl && originUrl !== repo) {
      die(`stackSource(${svc}): ${srcDir} origin '${originUrl}' != expected '${repo}' (re-clone manually if intended)`);
    }
  }

  // Reuse fast-path. Two cases:
  //   (a) lock matches + HEAD matches lock — the standard reuse path.
  //   (b) lock missing but HEAD already matches `requested` (interpreted
  //       as a SHA) — common on a fresh .stack-node when _source/ was
  //       already cloned for a sibling stack. Adopt the existing checkout
  //       and seed the lock + rebuild flag (compose project doesn't share
  //       image tags across projects, so a fresh project needs the build).
  if (existsSync(resolve(srcDir, ".git"))) {
    let head = "";
    try { head = (await $`git -C ${srcDir} rev-parse HEAD`).stdout.trim(); } catch { /* ignore */ }
    const lockReq = generatedGet(svc, `${uc}_SOURCE_REQUESTED`);
    const lockSha = generatedGet(svc, `${uc}_SOURCE_RESOLVED_SHA`);
    if (lockReq && lockReq === requested && head && head === lockSha) {
      ensureDockerignore(srcDir);
      log(`stackSource(${svc}): reuse — ${requested} @ ${head.slice(0, 12)}`);
      return { reused: true, sha: head, requested };
    }
    if (!lockReq && head && /^[0-9a-f]{40}$/.test(requested) && head === requested) {
      ensureDockerignore(srcDir);
      generatedUpsert(svc, `${uc}_SOURCE_REQUESTED`, requested);
      generatedUpsert(svc, `${uc}_SOURCE_RESOLVED_SHA`, head);
      generatedUpsert(svc, `${uc}_SOURCE_REBUILD`, "1");
      log(`stackSource(${svc}): adopt existing checkout @ ${head.slice(0, 12)} (rebuild flag set for fresh project)`);
      return { reused: false, sha: head, requested };
    }
  }

  // Fresh clone if missing.
  if (!existsSync(resolve(srcDir, ".git"))) {
    if (existsSync(srcDir)) rmSync(srcDir, { recursive: true, force: true });
    log(`stackSource(${svc}): cloning ${repo}`);
    await $`git clone ${repo} ${srcDir}`;
  }

  await $`git -C ${srcDir} fetch --tags origin`;
  const tryRevParse = async (ref: string): Promise<string> => {
    try {
      return (await $`git -C ${srcDir} rev-parse --verify ${ref + "^{commit}"}`).stdout.trim();
    } catch {
      return "";
    }
  };
  let sha = await tryRevParse(requested);
  if (!sha) {
    try { await $`git -C ${srcDir} fetch origin ${requested}`; } catch { /* swallow */ }
    sha =
      (await tryRevParse(requested)) ||
      (await tryRevParse(`origin/${requested}`)) ||
      (await tryRevParse("FETCH_HEAD"));
  }
  if (!sha) {
    die(`stackSource(${svc}): cannot resolve '${requested}' in ${repo}`);
    throw new Error("unreachable");
  }

  await $`git -C ${srcDir} checkout --detach ${sha}`;
  ensureDockerignore(srcDir);

  generatedUpsert(svc, `${uc}_SOURCE_REQUESTED`, requested);
  generatedUpsert(svc, `${uc}_SOURCE_RESOLVED_SHA`, sha);
  generatedUpsert(svc, `${uc}_SOURCE_REBUILD`, "1");
  log(`stackSource(${svc}): pinned ${requested} -> ${sha.slice(0, 12)} (rebuild flag set)`);
  return { reused: false, sha, requested };
};

// Read + clear the rebuild flag in one go. Used by service build.ts after
// it's run `dc build` for the service.
export const consumeRebuildFlag = (svc: string): boolean => {
  const uc = svcUc(svc);
  const flag = generatedGet(svc, `${uc}_SOURCE_REBUILD`);
  if (!flag) return false;
  generatedUpsert(svc, `${uc}_SOURCE_REBUILD`, "");
  return true;
};
