// De Lijn client: Kern Open Data (stops, real-time, timetables, disruptions) + Zoek Open Data (stop search).
// Key: DELIJN_API_KEY secret (portal.delijn.be, product "Open Data Free"), sent as Ocp-Apim-Subscription-Key.

import { ToolError } from "./errors";
import { cachedJson, type Fetched } from "./http";

const KERN = "https://api.delijn.be/DLKernOpenData/api/v1";
const ZOEK = "https://api.delijn.be/DLZoekOpenData/v1";

export interface DelijnEnv {
  DELIJN_API_KEY?: string;
}

function get<T>(env: DelijnEnv, url: string, ttlSec: number): Promise<Fetched<T>> {
  if (!env.DELIJN_API_KEY)
    throw new ToolError("UPSTREAM_ERROR", "De Lijn is not configured on this server (no DELIJN_API_KEY secret).", "Tell the user De Lijn data needs the API key secret set.");
  return cachedJson<T>(url, {
    source: "De Lijn",
    headers: { "Ocp-Apim-Subscription-Key": env.DELIJN_API_KEY },
    ttlSec,
    notFoundHint: "Check the stop with find_stop (operator \"delijn\") and retry.",
  });
}

export const delijnKern = <T = any>(env: DelijnEnv, path: string, ttlSec: number) => get<T>(env, `${KERN}/${path}`, ttlSec);

export const delijnSearch = <T = any>(env: DelijnEnv, query: string) =>
  get<T>(env, `${ZOEK}/zoek/haltes/${encodeURIComponent(query.trim())}?maxAantalHits=40`, 86_400);
