// STIB-MIVB adapter: Belgian Mobility open data (api-management-opendata-production.azure-api.net), verified 2026-10-06.
// Quirks: nested JSON arrives as strings (name, points, passingtimes, content); names are UPPERCASE without accents;
// stopDetails ids may carry a letter suffix ("5088F") that WaitingTimes drops ("5088"); a stop name groups many points
// (one per platform/direction); waiting times have no schedule/delay, only expected times.

import { hhmm, isoDate } from "../time";
import type { Departure, Disruption, Mode, Stop } from "../types";

type Json = any;
type Lang = { fr?: string; nl?: string; en?: string };

const parse = <T>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : (v as T));
/** "5088F" -> "5088" (WaitingTimes / TravellersInformation use the bare id). */
export const pointKey = (id: string) => id.replace(/[A-Z]+$/, "");

const METRO = new Set(["1", "2", "5", "6"]);
const TRAM = new Set(["3", "4", "7", "8", "9", "10", "18", "19", "25", "35", "39", "51", "55", "62", "81", "82", "92", "93", "97"]);

export function lineMode(lineId: string): Mode {
  const n = lineId.replace(/^T/, "");
  if (/^T\d/.test(lineId) || TRAM.has(n)) return "tram";
  return METRO.has(n) ? "metro" : "bus";
}

/** "2" -> "M2", "T81" -> "T81", "71" -> "B71", "N04" -> "N04" */
const lineNum = (l: string) => Number(l.replace(/\D/g, ""));
const labelMemo = new Map<string, string>();
export function lineLabel(lineId: string): string {
  let v = labelMemo.get(lineId);
  if (v === undefined) labelMemo.set(lineId, (v = lineLabelUncached(lineId)));
  return v;
}
function lineLabelUncached(lineId: string): string {
  if (/^[A-Z]/.test(lineId)) return lineId;
  return { metro: "M", tram: "T", bus: "B", train: "" }[lineMode(lineId)] + lineId;
}

const SMALL = new Set(["de", "du", "des", "la", "le", "les", "l", "d", "van", "der", "den", "het", "ter"]);
/** "GARE DU MIDI" -> "Gare du Midi" */
const titleMemo = new Map<string, string>();
export function titleCase(s: string): string {
  let v = titleMemo.get(s);
  if (v === undefined) {
    v = s.toLowerCase().replace(/[\p{L}\d]+/gu, (w, i: number) => (i > 0 && SMALL.has(w) ? w : w[0].toUpperCase() + w.slice(1)));
    titleMemo.set(s, v);
  }
  return v;
}

export const stibStopId = (fr: string) => `stib:${fr}`;

/** Group stopDetails points by FR name into one Stop per name, with the lines that serve it. */
export function mapStibStops(stopDetails: Json, stopsByLine: Json): Stop[] {
  const linesAt = new Map<string, Set<string>>();
  for (const l of stopsByLine.results as Json[])
    for (const p of parse<{ id: string }[]>(l.points)) {
      const k = pointKey(p.id);
      if (!linesAt.has(k)) linesAt.set(k, new Set());
      linesAt.get(k)!.add(l.lineid);
    }

  const groups = new Map<string, { nl: string; points: Set<string>; lat: number[]; lon: number[] }>();
  for (const r of stopDetails.results as Json[]) {
    const n = parse<Lang>(r.name);
    if (!n?.fr) continue;
    const g = groups.get(n.fr) ?? { nl: n.nl ?? n.fr, points: new Set<string>(), lat: [], lon: [] };
    g.points.add(pointKey(r.id));
    const c = parse<{ latitude: number; longitude: number } | null>(r.gpscoordinates);
    if (c) g.lat.push(Number(c.latitude)), g.lon.push(Number(c.longitude));
    groups.set(n.fr, g);
  }

  const avg = (a: number[]) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 1e6) / 1e6 : 0);
  return [...groups].map(([fr, g]): Stop => {
    const [frT, nlT] = [titleCase(fr), titleCase(g.nl)];
    const points = [...g.points].sort();
    const lines = [...new Set(points.flatMap((p) => [...(linesAt.get(p) ?? [])]))];
    // Numeric order, then plain code-unit order (labels are ASCII; localeCompare is ~10× slower).
    lines.sort((a, b) => lineNum(a) - lineNum(b) || (a < b ? -1 : a > b ? 1 : 0));
    return {
      id: stibStopId(fr),
      operator: "stib",
      name: frT === nlT ? frT : `${frT} / ${nlT}`,
      names: [...new Set([frT, nlT])],
      namesByLang: { fr: frT, nl: nlT },
      lat: avg(g.lat),
      lon: avg(g.lon),
      points,
      lines: lines.map(lineLabel),
    };
  });
}

/** Live departures at a STIB stop. Items keep realtimeTime; `inMin` is minutes from `nowMs`. */
export function mapWaitingTimes(wt: Json, stop: Stop, nowMs: number): { items: Departure[]; ended: string[] } {
  const items: Departure[] = [];
  const ended = new Set<string>();
  const mine = new Set(stop.points ?? []);
  for (const r of wt.results as Json[]) {
    if (!mine.has(String(r.pointid))) continue;
    const passings = parse<Json[]>(r.passingtimes) ?? [];
    const label = lineLabel(r.lineid);
    if (passings.some((p) => p.message?.en === "End of service")) {
      ended.add(label);
      continue;
    }
    for (const p of passings) {
      // Passings without a destination are placeholders (they repeat the previous time); skip them.
      if (!p.destination?.fr) continue;
      const ms = Date.parse(p.expectedArrivalTime);
      if (Number.isNaN(ms)) continue;
      const inMin = Math.max(0, Math.round((ms - nowMs) / 60_000));
      if (ms < nowMs - 60_000) continue;
      const t = Math.floor(ms / 1000);
      items.push({
        operator: "stib",
        mode: lineMode(r.lineid),
        line: label,
        destination: titleCase(p.destination.fr),
        date: isoDate(t),
        scheduledTime: hhmm(t),
        realtimeTime: hhmm(t),
        delayMin: 0,
        platformChanged: false,
        cancelled: false,
        inMin,
        ts: t,
        live: true,
        note: p.message?.en === "Last departure" ? "last" : undefined,
        stopId: stop.id,
        stopName: stop.name,
      });
    }
  }
  items.sort((a, b) => (a.inMin ?? 0) - (b.inMin ?? 0));
  // A line that still has departures elsewhere at this stop is not "ended" for the user.
  const running = new Set(items.map((d) => d.line));
  return { items, ended: [...ended].filter((l) => !running.has(l)) };
}

export interface StibNotice extends Disruption {
  lines: string[]; // labels, e.g. "T51"
  points: string[];
  priority: number;
}

/** TravellersInformation -> notices. "Works"/"Event" texts count as planned, everything else as incident. */
const tiMemo = new WeakMap<object, StibNotice[]>();
/** Memoized per raw response object (the per-isolate cache returns the same object); returns a fresh array. */
export function mapTravellersInfo(ti: Json): StibNotice[] {
  let v = tiMemo.get(ti);
  if (!v) tiMemo.set(ti, (v = mapTravellersInfoUncached(ti)));
  return v.slice();
}
function mapTravellersInfoUncached(ti: Json): StibNotice[] {
  return (ti.results as Json[]).flatMap((r): StibNotice[] => {
    const blocks = parse<{ text: Lang[] }[]>(r.content) ?? [];
    const t = blocks[0]?.text?.[0];
    const text = (t?.en ?? t?.fr ?? t?.nl ?? "").replace(/\s+/g, " ").trim();
    if (!text) return [];
    const lines = (parse<{ id: string }[]>(r.lines) ?? []).map((l) => lineLabel(l.id));
    return [
      {
        operator: "stib",
        type: /^(works|event|travaux|werken)\b/i.test(text) ? "planned" : "incident",
        title: lines.length > 4 ? `${lines.slice(0, 4).join(" ")} +${lines.length - 4}` : lines.join(" ") || "STIB",
        description: text,
        updated: "",
        lines,
        points: (parse<{ id: string }[]>(r.points) ?? []).map((p) => pointKey(p.id)),
        priority: Number(r.priority ?? 9),
        id: `stib:${r.id}`,
        stopIds: (parse<{ id: string }[]>(r.points) ?? []).map((p) => pointKey(p.id)),
      },
    ];
  });
}

/** Metro lines running from one stop's points to another's, in line order (stopsByLine). */
const linksMemo = new WeakMap<object, Map<string, ReturnType<typeof metroLinksUncached>>>();
export function metroLinks(stopsByLine: Json, fromPoints: string[], toPoints: string[]) {
  let m = linksMemo.get(stopsByLine);
  if (!m) linksMemo.set(stopsByLine, (m = new Map()));
  const key = `${fromPoints.join(",")}>${toPoints.join(",")}`;
  let v = m.get(key);
  if (!v) m.set(key, (v = metroLinksUncached(stopsByLine, fromPoints, toPoints)));
  return v.map((x) => ({ ...x }));
}
function metroLinksUncached(stopsByLine: Json, fromPoints: string[], toPoints: string[]): { line: string; destination: string; fromPoints: string[]; stops: number }[] {
  const from = new Set(fromPoints);
  const to = new Set(toPoints);
  const out: { line: string; destination: string; fromPoints: string[]; stops: number }[] = [];
  for (const l of stopsByLine.results as Json[]) {
    if (lineMode(l.lineid) !== "metro") continue;
    const pts = parse<{ id: string }[]>(l.points).map((p) => pointKey(p.id));
    const i = pts.findIndex((p) => from.has(p));
    if (i < 0) continue;
    const k = pts.findIndex((p, idx) => idx > i && to.has(p));
    if (k < 0) continue;
    out.push({ line: lineLabel(l.lineid), destination: titleCase(parse<Lang>(l.destination)?.fr ?? ""), fromPoints: [pts[i]], stops: k - i });
  }
  return out;
}
