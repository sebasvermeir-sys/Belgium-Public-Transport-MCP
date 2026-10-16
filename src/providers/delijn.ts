// De Lijn adapter: Kern Open Data + Zoek Open Data (api.delijn.be), verified 2026-10-06.
// Quirks: times are Brussels local without offset ("2026-10-06T08:12:00"); `lijnnummer` is internal (765) and the
// public number comes from /entiteiten/{e}/lijnen (`lijnnummerPubliek` "76", trams already "T4"); a place has one
// halte per platform/direction ("Gent Sint-Pietersstation perron 14"), so we group haltes by name.

import { stableId } from "../hash";
import { brusselsLocalToEpoch, brusselsParts, isoDateTime } from "../time";
import type { Departure, Disruption, Mode, Stop } from "../types";

type Json = any;

/** "Gent Sint-Pietersstation perron 14" / "Gent Rabot (Begijnhoflaan)" -> place name */
export const placeName = (s: string) =>
  s
    .replace(/\s+perron\s+\S+$/i, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim();

export const halteKey = (h: { entiteitnummer: string | number; haltenummer: string | number }) => `${h.entiteitnummer}_${h.haltenummer}`;

/**
 * De Lijn's search API (DLZoekOpenData) returns latitude and longitude swapped; the Kern API doesn't.
 * In Belgium latitude (49.5–51.5) is always larger than longitude (2.5–6.4), so put the larger one in lat.
 */
export function latLon(g: { latitude?: number; longitude?: number } | null | undefined): { lat: number; lon: number } | undefined {
  const a = Number(g?.latitude);
  const b = Number(g?.longitude);
  if (!a || !b) return undefined;
  return a >= b ? { lat: a, lon: b } : { lat: b, lon: a };
}

/** Zoek results -> one Stop per place, points = halte keys ("2_200274"). Order follows the API's ranking. */
export function groupSearch(search: Json): Stop[] {
  const groups = new Map<string, { points: string[]; lat: number[]; lon: number[]; variants: Set<string> }>();
  for (const h of (search.haltes ?? []) as Json[]) {
    const full: string = h.omschrijvingLang ?? h.omschrijving ?? "";
    if (!full) continue;
    const name = placeName(full);
    const g = groups.get(name) ?? { points: [], lat: [], lon: [], variants: new Set<string>() };
    const k = halteKey(h);
    if (!g.points.includes(k)) g.points.push(k);
    g.variants.add(full);
    const c = latLon(h.geoCoordinaat);
    if (c) g.lat.push(c.lat), g.lon.push(c.lon);
    groups.set(name, g);
  }
  const avg = (a: number[]) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 1e6) / 1e6 : 0);
  return [...groups].map(([name, g]) => ({
    id: `delijn:${g.points.join("_")}`,
    operator: "delijn" as const,
    name,
    names: [name],
    namesByLang: { nl: name },
    lat: avg(g.lat),
    lon: avg(g.lon),
    points: g.points,
  }));
}

/** "delijn:2_200274_2_201274" -> ["2_200274", "2_201274"] */
export function pointsFromId(id: string): string[] {
  const parts = id.replace(/^delijn:/, "").split("_");
  const out: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) out.push(`${parts[i]}_${parts[i + 1]}`);
  return out;
}

export interface LineInfo {
  label: string; // "T4", "B76"
  mode: Mode;
}

/** /entiteiten/{e}/lijnen -> "2_765" -> { label "B76", mode bus } */
export function lineIndex(...lists: Json[]): Map<string, LineInfo> {
  const m = new Map<string, LineInfo>();
  for (const j of lists)
    for (const l of (j?.lijnen ?? []) as Json[]) {
      const mode: Mode = l.vervoertype === "TRAM" ? "tram" : "bus";
      const pub = String(l.lijnnummerPubliek ?? l.lijnnummer);
      m.set(`${l.entiteitnummer}_${l.lijnnummer}`, { label: !/^\d/.test(pub) ? pub : mode === "tram" ? `T${pub}` : `B${pub}`, mode });
    }
  return m;
}

const localIso = (ts: number) => {
  const p = brusselsParts(Math.floor(ts));
  return `${p.y}-${p.m}-${p.d}T${p.hh}:${p.mm}:${p.ss}`;
};

const CANCELLED = /SCHRAP|ANNUL|CANCEL/i;

/** real-time or dienstregelingen (single halte or lijst) -> departures. */
export function mapDoorkomsten(
  j: Json,
  stop: Stop,
  lines: Map<string, LineInfo>,
  nowMs: number,
  fromMs = nowMs - 60_000,
  onlyTrips?: Set<string>, // keep only these trip keys (destination side of an A → B query)
  untilMs?: number, // skip trips after this (commute_check only needs a few hours)
): Departure[] {
  const halteLists: Json[] = j.halteDoorkomstenLijst
    ? j.halteDoorkomstenLijst.flatMap((x: Json) => x.halteDoorkomsten ?? [])
    : (j.halteDoorkomsten ?? []);
  const seen = new Set<string>();
  const out: Departure[] = [];
  // Local "YYYY-MM-DDTHH:mm:ss" strings sort like times: skip earlier trips before any date math (hot loop).
  const fromLocal = fromMs > 0 ? localIso(fromMs / 1000) : "";
  const untilLocal = untilMs ? localIso(untilMs / 1000) : "";
  for (const h of halteLists)
    for (const d of (h.doorkomsten ?? []) as Json[]) {
      const t = String(d["real-timeTijdstip"] ?? d.dienstregelingTijdstip);
      if ((fromLocal && t < fromLocal) || (untilLocal && t > untilLocal)) continue;
      if (seen.has(d.doorkomstId)) continue;
      seen.add(d.doorkomstId);
      if (onlyTrips && !onlyTrips.has(String(d.doorkomstId).split("_", 3).join("_"))) continue;
      const sched = brusselsLocalToEpoch(d.dienstregelingTijdstip);
      const rtRaw = d["real-timeTijdstip"];
      const rt = rtRaw ? brusselsLocalToEpoch(rtRaw) : sched;
      if (Number.isNaN(sched) || rt * 1000 < fromMs) continue;
      const info = lines.get(`${d.entiteitnummer}_${d.lijnnummer}`) ?? { label: `B${d.lijnnummer}`, mode: "bus" as Mode };
      out.push({
        operator: "delijn",
        mode: info.mode,
        line: info.label,
        destination: d.bestemming ?? d.plaatsBestemming ?? "?",
        // De Lijn times are already Brussels-local strings: slice instead of formatting the epoch back (hot loop).
        date: String(d.dienstregelingTijdstip).slice(0, 10),
        scheduledTime: String(d.dienstregelingTijdstip).slice(11, 16),
        realtimeTime: String(rtRaw ?? d.dienstregelingTijdstip).slice(11, 16),
        delayMin: Math.round((rt - sched) / 60),
        platformChanged: false,
        cancelled: (d.predictionStatussen ?? []).some((s: string) => CANCELLED.test(s)),
        inMin: Math.max(0, Math.round((rt * 1000 - nowMs) / 60_000)),
        schedTs: sched,
        ts: rt,
        live: !!rtRaw,
        note: rtRaw ? undefined : "sched",
        tripKey: String(d.doorkomstId).split("_").slice(0, 3).join("_"),
        seq: Number(String(d.doorkomstId).split("_")[3]),
        stopId: stop.id,
        stopName: stop.name,
      });
    }
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0); // ASCII; localeCompare is much slower
  return out.sort((a, b) => cmp(a.date, b.date) || cmp(a.realtimeTime, b.realtimeTime));
}

/** storingen / omleidingen (lijst) -> disruptions, deduplicated across haltes. */
export function mapOmleidingen(j: Json, lines: Map<string, LineInfo>): Disruption[] {
  const seen = new Set<string>();
  const out: Disruption[] = [];
  for (const h of (j.halteOmleidingen ?? []) as Json[])
    for (const o of (h.omleidingen ?? []) as Json[]) {
      const text: string = (o.omschrijvingMeertaligKort?.engels ?? o.omschrijvingMeertalig?.engels ?? o.omschrijving ?? "").trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      const labels = [
        ...new Set(((o.lijnrichtingen ?? []) as Json[]).map((l) => lines.get(`${l.entiteitnummer}_${l.lijnnummer}`)?.label ?? `B${l.lijnnummer}`)),
      ];
      const title: string = o.titelMeertalig?.engels ?? o.titel ?? "De Lijn";
      const start = o.periode?.startDatum ? brusselsLocalToEpoch(o.periode.startDatum) : NaN;
      const end = o.periode?.eindDatum ? brusselsLocalToEpoch(o.periode.eindDatum) : NaN;
      out.push({
        operator: "delijn",
        type: /onverwacht|unexpected|storing/i.test(`${o.titel} ${title}`) ? "incident" : "planned",
        title: `${labels.join(" ")}${labels.length ? " · " : ""}${title}`,
        description: text,
        updated: Number.isNaN(start) ? "" : isoDateTime(start),
        id: stableId("delijn", text, o.periode?.startDatum),
        validFrom: Number.isNaN(start) ? undefined : start,
        validUntil: Number.isNaN(end) ? undefined : end,
        lines: labels,
        stopIds: ((o.haltes ?? []) as Json[]).map((h) => halteKey(h)),
      });
    }
  return out;
}

const addMin = (t: string, n: number) => {
  const [h, m] = t.split(":").map(Number);
  const x = (((h * 60 + m + n) % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
};

/** Keep departures whose trip later stops at the destination; set arrival time (scheduled there + current delay). */
export function keepTripsTo(origin: Departure[], destination: Departure[]): Departure[] {
  const at = new Map<string, Departure[]>();
  for (const d of destination) if (d.tripKey) at.set(d.tripKey, [...(at.get(d.tripKey) ?? []), d]);
  return origin.flatMap((o) => {
    const hit = (at.get(o.tripKey ?? "") ?? []).find((d) => (d.seq ?? 0) > (o.seq ?? 0));
    return hit
      ? [{ ...o, arrivalTime: addMin(hit.scheduledTime, o.delayMin), arrivalStop: hit.stopName, arrivalTs: (hit.schedTs ?? 0) + o.delayMin * 60 }]
      : [];
  });
}
