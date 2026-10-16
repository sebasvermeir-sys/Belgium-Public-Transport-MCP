// Stop search: FR/NL/EN names, abbreviations and typos.
// Holds SNCB stations (~700) + STIB stops grouped by name (~1,100) in memory (cached in KV). D1 FTS5 arrives with De Lijn (~35k stops).

import { ToolError } from "./errors";
import type { Operator, Stop } from "./types";

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((t) => (t === "st" ? "sint" : t === "ste" ? "sainte" : t))
    .join(" ");
}

// Common nicknames for the user's stops. Value = stop id (SNCB station id or stib:<FR NAME>).
const ALIASES: Record<string, string> = {
  midi: "BE.NMBS.008814001",
  zuid: "BE.NMBS.008814001",
  "brussels south": "BE.NMBS.008814001",
  "brussel zuid": "BE.NMBS.008814001",
  "bruxelles midi": "BE.NMBS.008814001",
  gent: "BE.NMBS.008892007",
  ghent: "BE.NMBS.008892007",
  gand: "BE.NMBS.008892007",
  "gent sint pieters": "BE.NMBS.008892007",
  central: "BE.NMBS.008813003",
  centraal: "BE.NMBS.008813003",
  nord: "BE.NMBS.008812005",
  noord: "BE.NMBS.008812005",
  "midi metro": "stib:GARE DU MIDI",
  "metro midi": "stib:GARE DU MIDI",
  "zuid metro": "stib:GARE DU MIDI",
  "metro zuid": "stib:GARE DU MIDI",
};

// Reused buffer for the edit-distance rows (hot loop: thousands of words per search).
let row = new Uint16Array(64);

/** Edit distance if it is <= k, else k + 1 (stops as soon as a whole row exceeds k). */
function levWithin(a: string, b: string, k: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > k) return k + 1;
  if (row.length < b.length + 1) row = new Uint16Array(b.length * 2 + 1);
  for (let j = 0; j <= b.length; j++) row[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    let min = row[0];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      const v = Math.min(row[j] + 1, row[j - 1] + 1, prev + (ca === b.charCodeAt(j - 1) ? 0 : 1));
      row[j] = v;
      if (v < min) min = v;
      prev = tmp;
    }
    if (min > k) return k + 1;
  }
  return row[b.length];
}

function tokenScore(q: string, n: string): number {
  if (q === n) return 1;
  if (q.length >= 3 && n.startsWith(q)) return 0.9;
  // sim >= 0.7 means distance <= 0.3 * max length; levWithin gives up as soon as that's impossible.
  const max = Math.max(q.length, n.length);
  const k = Math.floor(0.3 * max + 1e-9);
  const d = levWithin(q, n, k);
  if (d > k) return 0;
  const sim = 1 - d / max;
  return sim >= 0.7 ? sim * 0.85 : 0;
}

/** Score already-normalized query tokens against already-normalized name tokens. */
function scoreTokens(q: string, qt: string[], n: string, nt: string[]): number {
  if (!q) return 0;
  if (q === n) return 1.01;
  const used = new Set<number>();
  let sum = 0;
  for (const t of qt) {
    let best = 0;
    let bi = -1;
    for (let i = 0; i < nt.length; i++) {
      const sc = tokenScore(t, nt[i]);
      if (sc > best) [best, bi] = [sc, i];
      if (best === 1) break;
    }
    if (bi >= 0) used.add(bi);
    sum += best;
  }
  return (sum / qt.length) * 0.85 + 0.15 * (used.size / nt.length);
}

/** 0..1.01 — how well a query matches one name. */
export function scoreName(query: string, name: string): number {
  const q = normalize(query);
  const n = normalize(name);
  return scoreTokens(q, q.split(" "), n, n.split(" "));
}

// Normalized names per stop, computed once per stop object (stops live in module memos for an hour).
const normCache = new WeakMap<Stop, { n: string; t: string[] }[]>();
function stopNames(s: Stop) {
  let v = normCache.get(s);
  if (!v) {
    // Display name too: STIB/De Lijn names like "Trone / Troon" aren't in `names` as one string.
    v = [...new Set([s.name, ...s.names])].map((x) => {
      const n = normalize(x);
      return { n, t: n.split(" ") };
    });
    normCache.set(s, v);
  }
  return v;
}

export interface StopMatch {
  stop: Stop;
  score: number;
}

export function searchStops(stops: Stop[], query: string, operator?: Operator, limit = 5): StopMatch[] {
  const q = normalize(query);
  const pool = operator ? stops.filter((s) => s.operator === operator) : stops;
  const aliasId = ALIASES[q];
  const byId = pool.find((s) => s.id === query || s.id.endsWith(`.${query}`) || s.id.endsWith(`.00${query}`));
  if (byId) return [{ stop: byId, score: 2 }];
  const qt = q.split(" ");
  return pool
    .map((stop) => {
      let score = stop.id === aliasId ? 1.5 : 0;
      if (!score) for (const x of stopNames(stop)) score = Math.max(score, scoreTokens(q, qt, x.n, x.t));
      return { stop, score };
    })
    .filter((m) => m.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Resolve to exactly one stop, or throw an error telling Claude how to disambiguate. */
export function resolveStop(stops: Stop[], query: string, operator?: Operator): Stop {
  const m = searchStops(stops, query, operator);
  if (!m.length)
    throw new ToolError(
      "STOP_NOT_FOUND",
      `No stop matches "${query}".`,
      `Call find_stop with a different spelling (FR or NL name), e.g. find_stop("${query.split(/\s+/)[0]}").`,
    );
  // An exact name match (accents/case/punctuation ignored) always wins, e.g. "Trone / Troon" or "trône".
  const nq = normalize(query);
  const exact = m.filter((x) => stopNames(x.stop).some((n) => n.n === nq));
  if (exact.length === 1) return exact[0].stop;
  const [top, second] = m;
  const clear = top.score >= 1 || top.score >= 0.75 && (!second || top.score - second.score >= 0.08);
  if (clear) return top.stop;
  const names = m.slice(0, 4).map((x) => x.stop.name);
  throw new ToolError(
    "STOP_AMBIGUOUS",
    `Stop ambiguous: "${query}" could be ${names.join(", ")}.`,
    `Call again with the exact name or id, e.g. "${names[0]}".`,
    { candidates: m.slice(0, 4).map((x) => ({ id: x.stop.id, name: x.stop.name, operator: x.stop.operator, lat: x.stop.lat, lon: x.stop.lon })) },
  );
}

// Words that don't identify a station on their own (used when matching disruption texts).
const GENERIC = new Set(["brussel", "bruxelles", "brussels", "brux", "brus", "bru", "sint", "saint", "sainte", "station", "gare"]);

/** Keyword sets for a stop; a text "mentions" the stop if it contains every keyword of any set. */
export function stopKeywordSets(stop: Stop): string[][] {
  const sets = stop.names
    .flatMap((n) => n.split("/"))
    .map((n) => normalize(n).split(" ").filter((t) => !GENERIC.has(t)))
    .filter((s) => s.length);
  return [...new Map(sets.map((s) => [s.join(" "), s])).values()];
}

export function mentionsStop(text: string, sets: string[][]): boolean {
  const words = new Set(normalize(text).split(" "));
  return sets.some((set) => set.every((w) => words.has(w)));
}
