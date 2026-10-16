// STIB-MIVB client (Belgian Mobility open data portal). Key: BELGIAN_MOBILITY_KEY secret (one key for STIB, De Lijn and SNCB open data), sent as Ocp-Apim-Subscription-Key.

import { ToolError } from "./errors";
import { cachedJson, type Fetched } from "./http";

const BASE = "https://api-management-opendata-production.azure-api.net/api/datasets/stibmivb";

export interface StibEnv {
  BELGIAN_MOBILITY_KEY?: string;
}

export function stib<T = any>(
  env: StibEnv,
  dataset: "rt/WaitingTimes" | "rt/TravellersInformation" | "static/stopDetails" | "static/stopsByLine",
  ttlSec: number,
  where?: string,
): Promise<Fetched<T>> {
  if (!env.BELGIAN_MOBILITY_KEY)
    throw new ToolError("UPSTREAM_ERROR", "STIB is not configured on this server (no BELGIAN_MOBILITY_KEY secret).", "Tell the user STIB live data needs the API key secret set.");
  const qs = new URLSearchParams({ limit: "-1" });
  if (where) qs.set("where", where);
  return cachedJson<T>(`${BASE}/${dataset}?${qs}`, {
    source: "STIB",
    headers: { "Ocp-Apim-Subscription-Key": env.BELGIAN_MOBILITY_KEY },
    ttlSec,
  });
}

/** where-clause for a set of point ids: pointid in ("8301","8302") */
export const pointsWhere = (points: string[]) => `pointid in (${points.map((p) => `"${p.replace(/"/g, "")}"`).join(",")})`;
