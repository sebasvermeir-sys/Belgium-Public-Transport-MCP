// Shared JSON fetch with Cache API: fresh TTL + 10 min stale copy served when the upstream fails.
// Cache keys are the URL only, so API keys sent in headers never end up in a key.

import { ToolError } from "./errors";

const STALE_TTL = 600;
const TIMEOUT_MS = 8_000;

export interface Fetched<T> {
  data: T;
  staleSec?: number; // set when served from the stale copy after an upstream failure
}

export interface FetchOpts {
  source: string; // "iRail", "STIB": used in error messages
  headers: Record<string, string>;
  ttlSec: number;
  beforeFetch?: () => Promise<void>; // e.g. rate-limit throttle, only on cache miss
  notFoundHint?: string;
}

// Per-isolate layer in front of the Cache API: skips both the cache read and JSON.parse for repeated calls
// (apps often poll the same routes every few minutes). Parsed upstream data is treated as read-only by all mappers.
const mem = new Map<string, { data: unknown; until: number }>();
const MEM_MAX = 64;

export async function cachedJson<T = any>(url: string, o: FetchOpts): Promise<Fetched<T>> {
  const m = mem.get(url);
  if (m && Date.now() < m.until) return { data: m.data as T };
  const r = await cachedJsonUncached<T>(url, o);
  if (!r.staleSec) {
    if (mem.size >= MEM_MAX) mem.delete(mem.keys().next().value!);
    mem.set(url, { data: r.data, until: Date.now() + o.ttlSec * 1000 });
  }
  return r;
}

async function cachedJsonUncached<T>(url: string, o: FetchOpts): Promise<Fetched<T>> {
  const cache = typeof caches !== "undefined" ? (caches as unknown as { default: Cache }).default : undefined;
  const freshKey = new Request(url);
  const staleKey = new Request(`${url}${url.includes("?") ? "&" : "?"}__stale=1`);

  const hit = await cache?.match(freshKey);
  if (hit) return { data: await hit.json() };

  let res: Response | undefined;
  let timedOut = false;
  try {
    await o.beforeFetch?.();
    res = await fetch(url, { headers: { Accept: "application/json", ...o.headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    timedOut = (e as Error)?.name === "TimeoutError";
    res = undefined;
  }

  if (res?.ok) {
    const body = await res.text();
    const fetchedAt = String(Date.now());
    const put = (key: Request, ttl: number) =>
      cache?.put(
        key,
        new Response(body, {
          headers: { "Content-Type": "application/json", "Cache-Control": `s-maxage=${ttl}`, "X-Fetched-At": fetchedAt },
        }),
      );
    await Promise.all([put(freshKey, o.ttlSec), put(staleKey, STALE_TTL)]);
    return { data: JSON.parse(body) };
  }

  if (res?.status === 404) {
    const msg = await res.text().catch(() => "");
    throw new ToolError("NOT_FOUND", `${o.source} found nothing (${msg.slice(0, 120)}).`, o.notFoundHint ?? "Check the id and retry.");
  }

  const stale = await cache?.match(staleKey);
  if (stale) {
    const age = Math.round((Date.now() - Number(stale.headers.get("X-Fetched-At"))) / 1000);
    return { data: await stale.json(), staleSec: age };
  }
  if (res?.status === 429)
    throw new ToolError("UPSTREAM_RATE_LIMITED", `${o.source} is rate-limiting us right now.`, "Wait ~5 seconds and retry once.");
  if (timedOut)
    throw new ToolError("UPSTREAM_TIMEOUT", `${o.source} did not answer within ${TIMEOUT_MS / 1000} s.`, `Retry once; if it still fails, tell the user ${o.source} live data is temporarily unavailable.`);
  if (res?.status === 401 || res?.status === 403)
    throw new ToolError("UPSTREAM_ERROR", `${o.source} rejected our API key (HTTP ${res.status}).`, `Tell the user the ${o.source} API key needs checking.`);
  throw new ToolError(
    "UPSTREAM_ERROR",
    `${o.source} is unavailable (${res ? `HTTP ${res.status}` : "network error"}).`,
    `Retry once in a few seconds; if it still fails, tell the user ${o.source} live data is temporarily unavailable.`,
  );
}

export const staleNote = (s?: number) => (s ? `cached ${Math.max(1, Math.round(s / 60))} min ago (live source down)` : undefined);
