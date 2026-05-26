// http.ts — small fetch helpers used by service preflight scripts.
import { setTimeout as sleep } from "node:timers/promises";

export interface WaitForOptions {
  timeoutMs?: number;
  intervalMs?: number;
  acceptStatuses?: readonly number[];
}

// Poll a URL until it returns an accepted status (200 by default) or
// the timeout elapses. Returns true on success, false on timeout.
export const waitForOk = async (url: string, opts: WaitForOptions = {}): Promise<boolean> => {
  const timeout = opts.timeoutMs ?? 4 * 60 * 1000;
  const interval = opts.intervalMs ?? 5_000;
  const accept = new Set(opts.acceptStatuses ?? [200]);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(interval) });
      if (accept.has(res.status)) return true;
    } catch {
      // network error / DNS / timeout — keep polling
    }
    await sleep(interval);
  }
  return false;
};

export interface JsonRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

// Tiny JSON-in/JSON-out helper. Throws on non-2xx with the response body.
export const jsonRequest = async <T = unknown>(
  url: string,
  opts: JsonRequestOptions = {},
): Promise<T> => {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers ?? {}) };
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${opts.method ?? "GET"} ${url} -> ${res.status}\n${text}`);
  }
  return text ? JSON.parse(text) as T : (undefined as T);
};
