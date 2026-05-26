// hermes-env.test.ts — managed-block .env rewriter.
import { describe, expect, test, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { writeManagedBlock, MANAGED_OPEN, MANAGED_CLOSE } from "../lib/hermes-env.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "henv-"));
});

describe("first-time write", () => {
  test("writes managed block with no hint when file is missing", () => {
    const f = resolve(dir, "env");
    writeManagedBlock(f, "OPENROUTER_API_KEY=k\nTELEGRAM_BOT_TOKEN=t");
    const body = readFileSync(f, "utf8");
    expect(body.startsWith(MANAGED_OPEN)).toBe(true);
    expect(body).toMatch(/OPENROUTER_API_KEY=k/);
    expect(body).toContain(MANAGED_CLOSE);
    expect(body).not.toContain("# User vars below");
  });
});

describe("update mode", () => {
  test("replaces only the content between markers and preserves outside lines", () => {
    const f = resolve(dir, "env");
    writeFileSync(f,
      "USER_KEY=keep\n" +
      MANAGED_OPEN + "\n" +
      "OPENROUTER_API_KEY=old\n" +
      MANAGED_CLOSE + "\n" +
      "EXTRA_USER=also-keep\n");
    writeManagedBlock(f, "OPENROUTER_API_KEY=new\nTELEGRAM_BOT_TOKEN=t");
    const body = readFileSync(f, "utf8");
    expect(body).toMatch(/^USER_KEY=keep$/m);
    expect(body).toMatch(/^EXTRA_USER=also-keep$/m);
    expect(body).toMatch(/^OPENROUTER_API_KEY=new$/m);
    expect(body).not.toMatch(/^OPENROUTER_API_KEY=old$/m);
  });
});

describe("migrate mode", () => {
  test("strips stale top-level keys that the managed block now owns", () => {
    const f = resolve(dir, "env");
    writeFileSync(f, "OPENROUTER_API_KEY=stale\nUSER_OTHER=user-data\n");
    writeManagedBlock(f, "OPENROUTER_API_KEY=fresh\nTELEGRAM_BOT_TOKEN=t");
    const body = readFileSync(f, "utf8");
    // The stale top-level OPENROUTER_API_KEY should be gone:
    expect(body.match(/^OPENROUTER_API_KEY=/gm)?.length).toBe(1);
    // The non-managed line is preserved:
    expect(body).toMatch(/^USER_OTHER=user-data$/m);
    // Hint comment inserted:
    expect(body).toContain("# User vars below");
  });
});
