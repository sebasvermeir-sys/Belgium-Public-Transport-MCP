// Locks the chat text output: the structured output for apps must never change what the chat sees.

import { describe, expect, it } from "vitest";
import { CASES } from "./cases";
import { call } from "./helpers/harness";

describe("chat text output is unchanged", () => {
  for (const c of CASES)
    it(c.name, { timeout: 20_000 }, async () => {
      const r = await call(c.tool, c.args, c.at);
      expect(`${r.isError ? "[error] " : ""}${r.text}`).toMatchSnapshot();
    });
});

describe("upstream timeout", () => {
  it("aborts a hanging upstream after 8 s and says so", { timeout: 20_000 }, async () => {
    const { cachedJson } = await import("../src/http");
    const real = globalThis.fetch;
    globalThis.fetch = ((_: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
    const { vi } = await import("vitest");
    vi.useFakeTimers();
    try {
      const p = cachedJson("https://example.test/slow", { source: "iRail", headers: {}, ttlSec: 30 }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(8_100);
      const e = await p;
      expect(e.code).toBe("UPSTREAM_TIMEOUT");
      expect(e.message).toMatch(/within 8 s/);
    } finally {
      vi.useRealTimers();
      globalThis.fetch = real;
    }
  });
});
