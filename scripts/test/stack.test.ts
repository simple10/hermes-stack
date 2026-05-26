// stack.test.ts — block-aware reads/writes + enable/disable cascade.
//
// Pool=forks (vitest config) gives us a fresh process per file so the
// HERMES_STACK_DIR_OVERRIDE env var only affects this run. Each test
// sets the override + re-imports the lib via vi.resetModules so STACK_DIR
// is recomputed from scratch.
import { describe, expect, test, beforeEach, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const setup = async (): Promise<{
  STACK_ENV: string;
  stack: typeof import("../lib/stack.ts");
}> => {
  vi.resetModules();
  const dir = mkdtempSync(resolve(tmpdir(), "stack-"));
  process.env.HERMES_STACK_DIR_OVERRIDE = dir;
  const paths = await import("../lib/paths.ts");
  const stack = await import("../lib/stack.ts");
  // services.ts caches the owner map across imports; reset it.
  const { _resetServiceCache } = await import("../lib/services.ts");
  _resetServiceCache();
  return { STACK_ENV: paths.STACK_ENV, stack };
};

beforeEach(() => {
  delete process.env.HERMES_STACK_DIR_OVERRIDE;
});

describe("block status / append / toggle", () => {
  test("missing -> append makes it enabled", async () => {
    const { STACK_ENV, stack } = await setup();
    expect(stack.blockStatus("hermes")).toBe("missing");
    writeFileSync(STACK_ENV, "");
    stack.blockAppend("hermes", "HERMES_REMOTE_USER=hermes\nHERMES_MODEL=cliproxy/gpt-5.5\n");
    expect(stack.blockStatus("hermes")).toBe("enabled");
    const body = readFileSync(STACK_ENV, "utf8");
    expect(body).toMatch(/#>--- hermes ---/);
    expect(body).toMatch(/#<--- hermes ---/);
    expect(body).toMatch(/HERMES_REMOTE_USER=hermes/);
  });

  test("toggle disabled prefixes lines with '# '; toggle enabled strips them", async () => {
    const { STACK_ENV, stack } = await setup();
    writeFileSync(STACK_ENV, "");
    stack.blockAppend("hermes", "HERMES_REMOTE_USER=hermes\n");
    stack.blockToggle("hermes", "disabled");
    expect(stack.blockStatus("hermes")).toBe("disabled");
    expect(readFileSync(STACK_ENV, "utf8")).toMatch(/^# HERMES_REMOTE_USER=hermes$/m);
    stack.blockToggle("hermes", "enabled");
    expect(stack.blockStatus("hermes")).toBe("enabled");
    expect(readFileSync(STACK_ENV, "utf8")).toMatch(/^HERMES_REMOTE_USER=hermes$/m);
  });
});

describe("stackUpsert routing", () => {
  test("block-owned KEY lands inside the right block", async () => {
    const { STACK_ENV, stack } = await setup();
    writeFileSync(STACK_ENV, "");
    stack.enableService("hermes");
    stack.stackUpsert("HERMES_TELEGRAM_BOT_TOKEN", "test-token");
    const body = readFileSync(STACK_ENV, "utf8");
    const sectionMatch = body.match(/#>--- hermes ---([\s\S]*?)#<--- hermes ---/);
    expect(sectionMatch).toBeTruthy();
    expect(sectionMatch![1]).toMatch(/HERMES_TELEGRAM_BOT_TOKEN=test-token/);
    // No top-level orphan with the same key:
    const topLevel = body.replace(/#>--- [\s\S]*?#<--- [^\n]*\n/g, "");
    expect(topLevel).not.toMatch(/^HERMES_TELEGRAM_BOT_TOKEN=/m);
  });

  test("top-level KEY goes to top of file", async () => {
    const { STACK_ENV, stack } = await setup();
    writeFileSync(STACK_ENV, "");
    stack.stackUpsert("COMPOSE_PROJECT_NAME", "hermes-node-test");
    expect(readFileSync(STACK_ENV, "utf8")).toMatch(/^COMPOSE_PROJECT_NAME=hermes-node-test$/m);
  });

  test("upserting a key whose block is disabled dies", async () => {
    const { STACK_ENV, stack } = await setup();
    writeFileSync(STACK_ENV, "");
    stack.enableService("hermes");
    stack.blockToggle("hermes", "disabled");
    // die() in lib/log.ts calls process.exit(1). vi can spy on it.
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error("__exit__");
    }) as never);
    expect(() => stack.stackUpsert("HERMES_TELEGRAM_BOT_TOKEN", "x")).toThrow("__exit__");
    exitSpy.mockRestore();
  });
});

describe("enable cascade", () => {
  test("enabling hermes pulls litellm, pg, redis", async () => {
    const { STACK_ENV, stack } = await setup();
    writeFileSync(STACK_ENV, "");
    const msgs: string[] = [];
    stack.enableService("hermes", (m) => msgs.push(m));
    expect(msgs).toContain("auto-enabling litellm (required by hermes)");
    expect(msgs).toContain("auto-enabling pg (required by litellm)");
    expect(msgs).toContain("auto-enabling redis (required by litellm)");
    const body = readFileSync(STACK_ENV, "utf8");
    expect(body).toMatch(/^COMPOSE_PROFILES=pg,redis,litellm$/m);
    expect(body).toMatch(/^STACK_MACHINES=hermes$/m);
    expect(body).toMatch(/^LITELLM_VIRTKEYS=hermes$/m);
  });

  test("enabling honcho-ui pulls honcho + pg/redis/litellm", async () => {
    const { STACK_ENV, stack } = await setup();
    writeFileSync(STACK_ENV, "");
    stack.enableService("honcho-ui");
    const csv = readFileSync(STACK_ENV, "utf8").match(/^COMPOSE_PROFILES=(.*)$/m)![1];
    const enabled = new Set(csv.split(","));
    expect(enabled).toContain("pg");
    expect(enabled).toContain("redis");
    expect(enabled).toContain("litellm");
    expect(enabled).toContain("honcho");
    expect(enabled).toContain("honcho-ui");
  });
});

describe("disable / dependants guard", () => {
  test("refuses to disable a service that is still required", async () => {
    const { STACK_ENV, stack } = await setup();
    writeFileSync(STACK_ENV, "");
    stack.enableService("honcho-ui"); // pulls honcho
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error("__exit__");
    }) as never);
    expect(() => stack.disableService("honcho")).toThrow();
    exitSpy.mockRestore();
  });

  test("can disable a leaf service", async () => {
    const { STACK_ENV, stack } = await setup();
    writeFileSync(STACK_ENV, "");
    stack.enableService("honcho-ui");
    const r = stack.disableService("honcho-ui");
    expect(r.changed).toBe(true);
    const csv = readFileSync(STACK_ENV, "utf8").match(/^COMPOSE_PROFILES=(.*)$/m)![1];
    expect(csv.split(",")).not.toContain("honcho-ui");
  });
});
