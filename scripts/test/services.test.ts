// services.test.ts — validate that every real services/*/service.env in
// the repo parses cleanly (dotenv handles it) and the cascade is
// cycle-safe.
import { describe, expect, test } from "vitest";
import { listServices, expandRequires } from "../lib/services.ts";

describe("services discovery", () => {
  test("at least the key services are present and well-formed", () => {
    const names = new Set(listServices().map((s) => s.name));
    for (const expected of [
      "pg", "redis", "litellm", "honcho", "honcho-ui",
      "cliproxyapi", "searxng", "camofox-browser",
      "localhost-proxy", "hermes",
    ]) {
      expect(names, `missing service: ${expected}`).toContain(expected);
    }
  });

  test("every service declares a runner and a (possibly empty) requires list", () => {
    for (const s of listServices()) {
      expect(["docker", "vm"]).toContain(s.runner);
      expect(Array.isArray(s.requires)).toBe(true);
    }
  });

  test("cascade closure for hermes leaves no duplicates and contains litellm + pg + redis", () => {
    const order = expandRequires(["hermes"]);
    const set = new Set(order);
    expect(set.size).toBe(order.length);
    for (const dep of ["litellm", "pg", "redis", "hermes"]) {
      expect(set, `missing in closure: ${dep}`).toContain(dep);
    }
    // pg should come before litellm in leaf-first order:
    expect(order.indexOf("pg")).toBeLessThan(order.indexOf("litellm"));
    expect(order.indexOf("litellm")).toBeLessThan(order.indexOf("hermes"));
  });
});
