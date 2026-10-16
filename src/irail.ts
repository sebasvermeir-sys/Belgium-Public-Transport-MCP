// iRail HTTP client: shared cache (src/http.ts) plus <3 req/s per isolate.

import { cachedJson, type Fetched } from "./http";

export { staleNote } from "./http";

const BASE = "https://api.irail.be/v1";

let recent: number[] = [];
async function throttle() {
  // iRail allows 3 req/s per IP (+5 burst). Stay under 3/s within this isolate.
  for (;;) {
    const now = Date.now();
    recent = recent.filter((t) => t <= now && now - t < 1000); // t > now: clock moved back; drop it
    if (recent.length < 3) return void recent.push(now);
    await new Promise((r) => setTimeout(r, 1000 - (now - recent[0]) + 5));
  }
}

export interface IrailEnv {
  IRAIL_USER_AGENT: string;
}

export function irail<T = any>(
  env: IrailEnv,
  path: string,
  params: Record<string, string | undefined>,
  ttlSec: number,
): Promise<Fetched<T>> {
  const qs = new URLSearchParams({ format: "json" });
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, v);
  return cachedJson<T>(`${BASE}/${path}?${qs}`, {
    source: "iRail",
    headers: { "User-Agent": env.IRAIL_USER_AGENT },
    ttlSec,
    beforeFetch: throttle,
    notFoundHint: "Check the station/train id (use find_stop or plan_journey to get one) and retry.",
  });
}
