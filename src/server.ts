// MCP server factory: one fresh McpServer per request (stateless createMcpHandler model).

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { errorResult, ToolError } from "./errors";
import {
  BoardS,
  boardOut,
  CommuteS,
  commuteOut,
  CompositionS,
  compositionOut,
  disruptionOut,
  DisruptionsS,
  errorOut,
  FindStopS,
  findStopOut,
  journeyOut,
  meta,
  isoAt,
  PlanJourneyS,
  stopOut,
  TrainStatusS,
  trainOut,
} from "./structured";
import { COMMUTE_DEFAULTS, eveningPlans, formatCommute, fromMin, type MetroLive, morningPlans, toMin } from "./commute";
import { delijnKern, delijnSearch } from "./delijn";
import {
  formatBoard,
  formatComposition,
  formatDelijnBoard,
  formatDisruptions,
  formatJourneys,
  formatStibBoard,
  formatTrain,
  stopLine,
} from "./format";
import { irail, staleNote } from "./irail";
import {
  mapComposition,
  mapConnections,
  mapDisturbances,
  mapLiveboard,
  mapStations,
  mapVehicle,
  normalizeTrainId,
} from "./providers/sncb";
import { groupSearch, keepTripsTo, lineIndex, mapDoorkomsten, mapOmleidingen, pointsFromId } from "./providers/delijn";
import { lineLabel, mapStibStops, mapTravellersInfo, mapWaitingTimes, metroLinks } from "./providers/stib";
import { pointsWhere, stib } from "./stib";
import { mentionsStop, normalize, resolveStop, scoreName, searchStops, stopKeywordSets } from "./stops";
import { brusselsLocalToEpoch, DATE_RE, hhmm, irailDateTime, isoDate, nowSec, TIME_RE } from "./time";
import type { Board, Departure, Disruption, Operator, Stop } from "./types";

export interface Env {
  MCP_TOKEN: string;
  IRAIL_USER_AGENT: string;
  INCLUDE_STRUCTURED?: string; // "1" = structured output for every caller (normally only APP_TOKEN gets it)
  APP_TOKEN?: string;
  BELGIAN_MOBILITY_KEY?: string;
  DELIJN_API_KEY?: string;
  CACHE?: KVNamespace;
}

const INSTRUCTIONS = `Belgian public transport: SNCB trains, STIB (Brussels metro/tram/bus) and De Lijn (Flemish bus/tram, e.g. Gent). All times Europe/Brussels, 24h.
- Specific train between two stations ("is my 08:04 Midi → Gent on time, which platform?"): use plan_journey with time ~5 min before; trains often run beyond the station the user names, so departures' destination filter can miss them. plan_journey is trains only.
- Live board at one stop: departures (SNCB, STIB or De Lijn) / arrivals (SNCB). Full stop list of one train: train_status.
- STIB: departures gives live waiting times now (no future times), grouped per line and direction, e.g. "M2 → Simonis · 3, 9 min". Lines are labelled M (metro), T (tram), B (bus). For metro at a station that is also a train station (Midi, Nord, Central…), pass operator "stib" (or "midi metro").
- De Lijn: departures shows scheduled time + live delay per line and direction, e.g. "B55 → Zelzate Busstation · 07:59 (+2), 08:29 · in 4 min"; pass time/date for the timetable later. For "which bus from A to B" pass to: B — it keeps only trips that stop at B and lists one trip per line: "08:05 B55 (dir. Zelzate) · arr 08:13" (arrival at B). A De Lijn place groups all its platforms (Gent Sint-Pietersstation = 16 perrons). For buses/trams at a place that is also a train station (Gent Sint-Pietersstation), pass operator "delijn".
- Stop names accept FR/NL/EN and nicknames ("midi", "Gent St Pieters", "Arts-Loi", "De Brouckère"). On STOP_AMBIGUOUS, retry with one of the candidates.
- disruptions: SNCB by default; STIB when operator "stib", a STIB line, or a STIB stop is given; De Lijn for a De Lijn stop (station required).
- commute_check: a full door-to-door Brussels ⇄ Gent trip in one call (home STIB stop → metro → Bruxelles-Midi → train → Gent-Sint-Pieters → De Lijn bus → destination stop, or the reverse), 3 plans. Pass the user's own home and destination stops; never assume them.
- "(+3)" = 3 min late; "(changed)" = platform changed; "left" = already departed.`;

// ---------- stop lists (KV + per-isolate memo) ----------
// Building a list (parse + map ~7–10 ms CPU) can exceed the free plan's 10 ms limit, and a killed request never
// writes KV, so every cold isolate would retry and die. A cron (src/index.ts `scheduled`) rebuilds the lists into
// KV every 6 h with a 3-day TTL; requests only read KV. Building in a request is the last-resort fallback.
const DAY = 86_400;
const STOPS_TTL = 3 * DAY;
const KV_SNCB = "sncb:stations:v2";
const KV_STIB = "stib:stops:v2";
let memo: { at: number; stops: Stop[] } | undefined;
let stibMemo: { at: number; stops: Stop[] } | undefined;

export async function buildSncbStops(env: Env): Promise<Stop[]> {
  const [en, nl, fr] = await Promise.all(["en", "nl", "fr"].map((lang) => irail(env, "stations", { lang }, DAY).then((r) => r.data)));
  const stops = mapStations(en, nl, fr);
  await env.CACHE?.put(KV_SNCB, JSON.stringify(stops), { expirationTtl: STOPS_TTL });
  return stops;
}

export async function buildStibStops(env: Env): Promise<Stop[]> {
  const [sd, sbl] = await Promise.all([stib(env, "static/stopDetails", DAY), stib(env, "static/stopsByLine", DAY)]);
  const stops = mapStibStops(sd.data, sbl.data);
  await env.CACHE?.put(KV_STIB, JSON.stringify(stops), { expirationTtl: STOPS_TTL });
  return stops;
}

async function sncbStops(env: Env): Promise<Stop[]> {
  if (memo && Date.now() - memo.at < 3_600_000) return memo.stops;
  const stops = (await env.CACHE?.get<Stop[]>(KV_SNCB, "json")) ?? (await buildSncbStops(env));
  memo = { at: Date.now(), stops };
  return stops;
}

async function stibStops(env: Env): Promise<Stop[]> {
  if (!env.BELGIAN_MOBILITY_KEY) return [];
  if (stibMemo && Date.now() - stibMemo.at < 3_600_000) return stibMemo.stops;
  const stops = (await env.CACHE?.get<Stop[]>(KV_STIB, "json")) ?? (await buildStibStops(env));
  stibMemo = { at: Date.now(), stops };
  return stops;
}

async function allStops(env: Env, operator?: Operator): Promise<Stop[]> {
  if (operator === "sncb") return sncbStops(env);
  if (operator === "stib") {
    if (!env.BELGIAN_MOBILITY_KEY) throw new ToolError("BAD_INPUT", "STIB is not configured on this server.", 'Use operator "sncb" or omit it.');
    return stibStops(env);
  }
  // One source being down must not take the other's stops with it.
  const rs = await Promise.allSettled([sncbStops(env), stibStops(env)]);
  const ok = rs.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  if (!ok.length) {
    const failed = rs.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
  }
  return ok;
}

// ---------- De Lijn: stops come from its search API (35k stops, too many to hold) ----------
async function delijnCandidates(env: Env, query: string): Promise<Stop[]> {
  if (!env.DELIJN_API_KEY) return [];
  return groupSearch((await delijnSearch(env, query)).data);
}

async function delijnById(env: Env, id: string): Promise<Stop> {
  const pts = pointsFromId(id);
  const r = await delijnKern(env, `haltes/lijst/${pts.join("_")}`, DAY);
  const [first] = groupSearch(r.data);
  if (!first) throw new ToolError("STOP_NOT_FOUND", `No De Lijn stop ${id}.`, 'Call find_stop with operator "delijn".');
  return { ...first, id, points: pts };
}

async function delijnLines(env: Env, points: string[]) {
  const ents = [...new Set(points.map((p) => p.split("_")[0]))];
  const lists = await Promise.all(ents.map((e) => delijnKern(env, `entiteiten/${e}/lijnen`, DAY).then((r) => r.data)));
  return lineIndex(...lists);
}

// Successful resolutions per isolate (apps poll the same stops repeatedly). Errors aren't cached.
const resolved = new Map<string, { at: number; stop: Stop }>();

/** Resolve a stop across SNCB + STIB (in memory) and De Lijn (search API, only when memory has no exact hit). */
async function resolveAny(env: Env, query: string, operator?: Operator): Promise<Stop> {
  const key = `${operator ?? "*"}|${normalize(query)}`;
  const hit = resolved.get(key);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.stop;
  const stop = await resolveAnyUncached(env, query, operator);
  if (resolved.size > 500) resolved.clear();
  resolved.set(key, { at: Date.now(), stop });
  return stop;
}

async function resolveAnyUncached(env: Env, query: string, operator?: Operator): Promise<Stop> {
  if (query.startsWith("delijn:")) return delijnById(env, query);
  if (operator === "delijn") {
    if (!env.DELIJN_API_KEY) throw new ToolError("BAD_INPUT", "De Lijn is not configured on this server.", 'Use operator "sncb" or "stib", or omit it.');
    return resolveStop(await delijnCandidates(env, query), query, "delijn");
  }
  const mem = await allStops(env, operator);
  if (operator) return resolveStop(mem, query, operator);
  const top = searchStops(mem, query)[0];
  if (top && top.score >= 1) return top.stop;
  let dl: Stop[] = [];
  try {
    dl = await delijnCandidates(env, query);
  } catch {
    // De Lijn down: fall back to SNCB/STIB only.
  }
  return resolveStop([...mem, ...dl], query);
}

// ---------- schema cache ----------
// createMcpHandler needs a new McpServer per request, and the SDK converts every tool's zod schema to JSON Schema
// at registration (~3 ms per request for 8 tools). Build each schema once per isolate and memoize its conversion.
const schemaCache = new Map<string, unknown>();
function schemaOnce<T>(key: string, make: () => T): T {
  let v = schemaCache.get(key) as T | undefined;
  if (!v) {
    const s = make() as unknown as { "~standard": any };
    const std = s["~standard"];
    const json: Record<string, unknown> = {};
    // Same schema object for validation; only the JSON Schema conversion is cached.
    v = {
      "~standard": {
        version: std.version,
        vendor: std.vendor,
        types: std.types,
        validate: (value: unknown) => std.validate(value),
        jsonSchema: {
          input: (o: unknown) => (json.input ??= std.jsonSchema.input(o)),
          output: (o: unknown) => (json.output ??= std.jsonSchema.output(o)),
        },
      },
    } as unknown as T;
    schemaCache.set(key, v);
  }
  return v;
}

// ---------- shared schema bits ----------
const time = z.string().regex(TIME_RE, "HH:mm, 24h").optional().describe("Local Brussels time HH:mm (default now)");
const date = z.string().regex(DATE_RE, "YYYY-MM-DD").optional().describe("YYYY-MM-DD (default today)");
const trainId = z.string().min(2).describe('Train id, e.g. "IC 1517", "IC1517", "S1 1978"');


function filterBoard(b: Board, f: { destination?: string; line?: string } | undefined, limit: number): Board {
  let items: Departure[] = b.items;
  if (f?.destination) {
    const q = normalize(f.destination);
    items = items.filter((d) => normalize(d.destination).includes(q) || scoreName(q, d.destination) >= 0.75);
  }
  if (f?.line) {
    const q = normalize(f.line).replace(/ /g, "");
    const bare = (s: string) => s.replace(/^[mtb](?=\d)/, "");
    items = items.filter((d) =>
      d.operator !== "sncb"
        ? bare(normalize(d.line)) === bare(q)
        : normalize(d.line).replace(/ /g, "").startsWith(q) || d.vehicleId === q.toUpperCase(),
    );
  }
  return { ...b, items: items.slice(0, limit), total: items.length };
}

export interface BuildOpts {
  /** APP_TOKEN callers: add structuredContent + outputSchema (schema_version 1). The chat stays text-only. */
  structured?: boolean;
}

export function buildServer(env: Env, opts: BuildOpts = {}): McpServer {
  const server = new McpServer({ name: "belgian-transit", version: "0.5.0" }, { instructions: INSTRUCTIONS });
  const structured = !!opts.structured || env.INCLUDE_STRUCTURED === "1";
  // outputSchema is only declared for structured callers: once declared, every result must carry structuredContent.
  const out = <S>(key: string, schema: S) => (structured ? { outputSchema: schemaOnce(`out:${key}`, () => schema) } : {});

  type Result = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
  /** Text always; the structured payload is only built for structured callers. */
  const result = (text: string, data: () => Record<string, unknown>): Result => ({
    content: [{ type: "text" as const, text }],
    ...(structured ? { structuredContent: data() } : {}),
  });
  const wrap =
    <A>(fn: (a: A) => Promise<Result>) =>
    async (a: A): Promise<Result> => {
      try {
        return await fn(a);
      } catch (e) {
        const r = errorResult(e);
        if (!structured) return r;
        const err = e instanceof ToolError ? e : new ToolError("UPSTREAM_ERROR", r.content[0].text, "");
        return { ...r, structuredContent: errorOut(err) };
      }
    };

  server.registerTool(
    "find_stop",
    {
      description: "Find stations/stops by name (FR/NL/EN, nicknames, typos ok). Returns ids usable in other tools.",
      inputSchema: schemaOnce("in:find_stop", () => z.object({
        query: z.string().min(1).describe('e.g. "midi", "Brussel-Zuid", "Gent St Pieters"'),
        operator: z.enum(["sncb", "stib", "delijn"]).optional().describe("Restrict to one operator"),
      })),
      annotations: { readOnlyHint: true },
      ...out("FindStopS", FindStopS),
    },
    wrap(async ({ query, operator }) => {
      const mem = operator === "delijn" ? [] : await allStops(env, operator);
      let dl: Stop[] = [];
      if (!operator || operator === "delijn") {
        if (operator === "delijn" && !env.DELIJN_API_KEY) throw new ToolError("BAD_INPUT", "De Lijn is not configured on this server.", 'Use operator "sncb" or "stib", or omit it.');
        try {
          dl = await delijnCandidates(env, query);
        } catch (e) {
          if (operator === "delijn") throw e;
        }
      }
      const m = searchStops([...mem, ...dl], query, operator);
      if (!m.length) throw new ToolError("STOP_NOT_FOUND", `No stop matches "${query}".`, "Try another spelling or the FR/NL name.");
      return result(m.map((x) => stopLine(x.stop)).join("\n"), () =>
        findStopOut(meta([...new Set(m.map((x) => (x.stop.operator === "sncb" ? "irail" : x.stop.operator)))].join(","), Date.now()), m.map((x) => x.stop)),
      );
    }),
  );

  const boardSchema = schemaOnce("in:board", () => z.object({
    stop: z.string().min(1).describe("Station/stop name, nickname or id"),
    operator: z.enum(["sncb", "stib", "delijn"]).optional().describe('Force trains ("sncb"), Brussels metro/tram/bus ("stib") or Flemish bus/tram ("delijn")'),
    to: z
      .string()
      .optional()
      .describe('De Lijn only: keep buses/trams that later stop here and show arrival time, e.g. stop "Gent Sint-Pietersstation", to "Gent Zuid"'),
    time,
    date,
    limit: z.number().int().min(1).max(30).default(10),
    filter: z
      .object({
        destination: z.string().optional().describe("Final destination (departures) / origin (arrivals) contains this"),
        line: z.string().optional().describe('Train type or id ("IC", "S1", "IC 1517"), STIB line ("71", "M2", "T81") or De Lijn line ("T1", "555", "9b")'),
      })
      .optional(),
  }));

  for (const kind of ["departures", "arrivals"] as const) {
    server.registerTool(
      kind,
      {
        description:
          kind === "departures"
            ? "Departures at a train station (SNCB: delays, platforms, cancellations), a STIB stop (live waiting times, now only) or a De Lijn stop (live delays; timetable when time/date given). For a specific A→B train use plan_journey."
            : "Live arrival board for a train station (SNCB only: delays, platforms, cancellations).",
        inputSchema: boardSchema,
        annotations: { readOnlyHint: true },
        ...out("BoardS", BoardS),
      },
      wrap(async ({ stop, operator, to, time: t, date: d, limit, filter }) => {
        if (kind === "arrivals" && operator && operator !== "sncb")
          throw new ToolError("BAD_INPUT", `${operator === "stib" ? "STIB" : "De Lijn"} has no arrival boards here.`, `Use departures with operator "${operator}" instead.`);
        const op = kind === "arrivals" ? "sncb" : operator;
        const st = await resolveAny(env, stop, op);
        if (to && st.operator !== "delijn")
          throw new ToolError("BAD_INPUT", '"to" only works for De Lijn stops.', 'For trains use plan_journey; for De Lijn pass operator "delijn".');
        if (st.operator === "delijn") {
          const pts = st.points ?? pointsFromId(st.id);
          const dest = to ? await resolveAny(env, to, "delijn") : undefined;
          const destPts = dest ? (dest.points ?? pointsFromId(dest.id)) : [];
          const lines = await delijnLines(env, [...pts, ...destPts]);
          const live = !(t || d);
          const now = Date.now();
          let r;
          let items: Departure[];
          let header: string;
          if (live) {
            r = await delijnKern(env, `haltes/lijst/${pts.join("_")}/real-time?maxAantalDoorkomsten=10`, 20);
            items = mapDoorkomsten(r.data, st, lines, now);
            header = `live · now ${hhmm(nowSec())}`;
          } else {
            const day = d ?? isoDate(nowSec());
            const at = t ?? hhmm(nowSec());
            r = await delijnKern(env, `haltes/lijst/${pts.join("_")}/dienstregelingen?datum=${day}`, 3_600);
            items = mapDoorkomsten(r.data, st, lines, now, brusselsLocalToEpoch(`${day}T${at}:00`) * 1000 - 120_000);
            header = `timetable ${day} from ${at}`;
          }
          if (dest) {
            const day = d ?? isoDate(nowSec());
            const rd = await delijnKern(env, `haltes/lijst/${destPts.join("_")}/dienstregelingen?datum=${day}`, 3_600);
            items = keepTripsTo(items, mapDoorkomsten(rd.data, dest, lines, now, 0, new Set(items.map((x) => x.tripKey!))));
            header += ` · to ${dest.name}`;
          }
          const shown = filterBoard({ stopId: st.id, stopName: st.name, kind: "departures", items, total: items.length }, filter, 999);
          return result(formatDelijnBoard(st.name, header, shown.items, limit, live, staleNote(r.staleSec)), () =>
            boardOut(meta("delijn", now, r.staleSec), st, shown.items, [], dest, limit * 3),
          );
        }
        if (st.operator === "stib") {
          const r = await stib(env, "rt/WaitingTimes", 20, pointsWhere(st.points ?? []));
          const { items, ended } = mapWaitingTimes(r.data, st, Date.now());
          const shown = filterBoard({ stopId: st.id, stopName: st.name, kind: "departures", items, total: items.length }, filter, 999);
          const notes = [staleNote(r.staleSec), t || d ? "STIB gives live times only; time/date ignored" : undefined].filter(Boolean).join(" · ");
          const bare = (l: string) => normalize(l).replace(/^[mtb](?=\d)/, "");
          // Lines that serve this stop but have no live passings at all (typically at night) count as ended too.
          const live = new Set(items.map((x) => x.line));
          const silent = (st.lines ?? []).filter((l) => !live.has(l) && !ended.includes(l));
          const allEnded = [...ended, ...silent];
          const endedShown = filter?.destination ? [] : filter?.line ? allEnded.filter((l) => bare(l) === bare(filter.line!)) : allEnded;
          return result(formatStibBoard(st.name, hhmm(nowSec()), shown.items, endedShown, limit, notes || undefined), () =>
            boardOut(meta("stib", Date.now(), r.staleSec), st, shown.items, endedShown, undefined, limit * 3),
          );
        }
        const when = t || d ? irailDateTime(d, t, -5) : { date: undefined, time: undefined };
        const r = await irail(
          env,
          "liveboard",
          { id: st.id, lang: "en", arrdep: kind === "arrivals" ? "arrival" : "departure", ...when },
          25,
        );
        const board = filterBoard(mapLiveboard(r.data, kind), filter, limit);
        return result(formatBoard(board, staleNote(r.staleSec)), () => boardOut(meta("irail", Date.now(), r.staleSec), st, board.items));
      }),
    );
  }

  server.registerTool(
    "plan_journey",
    {
      description:
        "Train connections A→B (SNCB) with delays, platforms, transfers and alerts. Best tool for 'is my 08:04 from A to B on time / which platform'.",
      inputSchema: schemaOnce("in:plan_journey", () => z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        time,
        date,
        arrive_by: z.boolean().default(false).describe("Treat time as arrival deadline"),
        results: z.number().int().min(1).max(6).default(4),
      })),
      annotations: { readOnlyHint: true },
      ...out("PlanJourneyS", PlanJourneyS),
    },
    wrap(async ({ from, to, time: t, date: d, arrive_by, results }) => {
      const stops = await sncbStops(env);
      const [a, b] = [resolveStop(stops, from, "sncb"), resolveStop(stops, to, "sncb")];
      if (a.id === b.id) throw new ToolError("BAD_INPUT", `"${from}" and "${to}" are the same station.`, "Ask the user for a different origin or destination.");
      const when = t || d ? irailDateTime(d, t) : { date: undefined, time: undefined };
      const r = await irail(
        env,
        "connections",
        { from: a.id, to: b.id, lang: "en", timesel: arrive_by ? "arrival" : "departure", ...when },
        30,
      );
      const js = mapConnections(r.data).slice(0, results);
      return result(formatJourneys(js, a.name, b.name, staleNote(r.staleSec)), () => ({
        meta: meta("irail", Date.now(), r.staleSec),
        query: {
          from: stopOut(a),
          to: stopOut(b),
          time: t || d ? isoAt(brusselsLocalToEpoch(`${d ?? isoDate(nowSec())}T${t ?? hhmm(nowSec())}:00`)) : null,
          arrive_by,
        },
        journeys: js.map(journeyOut),
      }));
    }),
  );

  server.registerTool(
    "train_status",
    {
      description: "Live status of one train: every stop with time, delay, platform; ✓ = already passed.",
      inputSchema: schemaOnce("in:train_status", () => z.object({ train_id: trainId, date })),
      annotations: { readOnlyHint: true },
      ...out("TrainStatusS", TrainStatusS),
    },
    wrap(async ({ train_id, date: d }) => {
      const id = normalizeTrainId(train_id);
      const r = await irail(env, "vehicle", { id: `BE.NMBS.${id}`, lang: "en", date: d ? irailDateTime(d).date : undefined }, 30);
      const t = mapVehicle(r.data);
      const note = staleNote(r.staleSec);
      return result(formatTrain(t) + (note ? `\n(${note})` : ""), () => trainOut(meta("irail", Date.now(), r.staleSec), t));
    }),
  );

  server.registerTool(
    "disruptions",
    {
      description:
        "Incidents, detours and planned works. SNCB by default; STIB when operator is \"stib\", a STIB line is given, or the station is a STIB stop; De Lijn when the station is a De Lijn stop. Incidents listed first.",
      inputSchema: schemaOnce("in:disruptions", () => z.object({
        station: z.string().optional().describe("Only disruptions mentioning/affecting this station or stop"),
        operator: z.enum(["sncb", "stib", "delijn"]).optional(),
        line: z.string().optional().describe('STIB line ("71", "M2", "T51"), or De Lijn line together with a De Lijn station'),
        type: z.enum(["incident", "planned", "all"]).default("all"),
        limit: z.number().int().min(1).max(30).default(8),
      })),
      annotations: { readOnlyHint: true },
      ...out("DisruptionsS", DisruptionsS),
    },
    wrap(async ({ station, operator, line, type, limit }) => {
      const st = station ? await resolveAny(env, station, operator) : undefined;
      const op = operator ?? st?.operator ?? (line ? "stib" : "sncb");
      let ds: Disruption[];
      let staleSec: number | undefined;
      const scope = [st?.name, line ? lineLabel(line.toUpperCase().replace(/^[MB](?=\d)/, "")) : ""].filter(Boolean).join(" · ");
      if (op === "delijn") {
        if (!st) throw new ToolError("BAD_INPUT", "De Lijn disruptions need a stop.", 'Pass station, e.g. "Gent Zuid".');
        const pts = st.points ?? pointsFromId(st.id);
        const [r, lines] = await Promise.all([delijnKern(env, `haltes/lijst/${pts.join("_")}/storingen`, 60), delijnLines(env, pts)]);
        staleSec = r.staleSec;
        ds = mapOmleidingen(r.data, lines);
        if (line) {
          const bare = (l: string) => normalize(l).replace(/^[mtb](?=\d)/, "");
          ds = ds.filter((x) => x.title.split(" · ")[0].split(" ").some((l) => bare(l) === bare(line)));
        }
        ds.sort((x, y) => (x.type === y.type ? y.updated.localeCompare(x.updated) : x.type === "incident" ? -1 : 1));
      } else if (op === "stib") {
        const r = await stib(env, "rt/TravellersInformation", 60);
        staleSec = r.staleSec;
        let ns = mapTravellersInfo(r.data);
        if (structured) await stibStops(env); // stop coordinates for the structured output
        if (st?.points) {
          const pts = new Set(st.points);
          ns = ns.filter((n) => n.points.some((p) => pts.has(p)));
        }
        if (line) {
          const want = lineLabel(line.toUpperCase().replace(/^[MB](?=\d)/, ""));
          ns = ns.filter((n) => n.lines.includes(want));
        }
        ns.sort((x, y) => (x.type === y.type ? x.priority - y.priority : x.type === "incident" ? -1 : 1));
        ds = ns.map(({ points: _p, priority: _r, ...d }) => d);
      } else {
        const r = await irail(env, "disturbances", { lang: "en" }, 60);
        staleSec = r.staleSec;
        ds = mapDisturbances(r.data);
        if (st) {
          const sets = stopKeywordSets(st);
          ds = ds.filter((d) => mentionsStop(`${d.title} ${d.description}`, sets));
        }
        ds.sort((x, y) => (x.type === y.type ? y.updated.localeCompare(x.updated) : x.type === "incident" ? -1 : 1));
      }
      if (type !== "all") ds = ds.filter((d) => d.type === type);
      const shown = ds.slice(0, limit);
      return result(formatDisruptions(shown, ds.length, scope), () => {
        const stibAll = op === "stib" ? (stibMemo?.stops ?? []) : [];
        const stopsFor = (x: Disruption): Stop[] => {
          if (op === "stib") {
            const ids = new Set(x.stopIds ?? []);
            return stibAll.filter((s) => s.points?.some((p) => ids.has(p)));
          }
          if (op === "delijn") return st && x.stopIds?.some((k) => st.points?.includes(k)) ? [st] : [];
          return st ? [st] : [];
        };
        return {
          meta: meta(op === "sncb" ? "irail" : op, Date.now(), staleSec),
          total: ds.length,
          disruptions: shown.map((x) => disruptionOut(x, stopsFor(x))),
        };
      });
    }),
  );

  server.registerTool(
    "composition",
    {
      description: "Carriages of a train: length, 1st-class position, seats, toilets, bike spaces.",
      inputSchema: schemaOnce("in:composition", () => z.object({ train_id: trainId })),
      annotations: { readOnlyHint: true },
      ...out("CompositionS", CompositionS),
    },
    wrap(async ({ train_id }) => {
      const id = normalizeTrainId(train_id);
      const r = await irail(env, "composition", { id, lang: "en" }, 300);
      const c = mapComposition(r.data, id);
      return result(formatComposition(c), () => compositionOut(meta("irail", Date.now(), r.staleSec), c));
    }),
  );

  server.registerTool(
    "commute_check",
    {
      description:
        "Door-to-door Brussels ⇄ Gent commute: STIB metro (home stop ⇄ Bruxelles-Midi) + SNCB train (Midi ⇄ Gent-Sint-Pieters) + De Lijn bus (Gent-Sint-Pieters ⇄ destination stop), fitted together with live delays, 3 plans by default. \"to_gent\" = home → destination, \"to_brussels\" = the reverse; auto = to_gent before 13:00. Pass the user's own stops.",
      inputSchema: schemaOnce("in:commute_check", () => z.object({
        home: z.string().min(1).describe("The user's STIB metro stop in Brussels, e.g. \"Arts-Loi\""),
        destination: z.string().min(1).describe("The user's De Lijn stop in Gent, e.g. \"Gent Zuid\""),
        direction: z.enum(["auto", "to_gent", "to_brussels"]).default("auto"),
        time: z.string().regex(TIME_RE, "HH:mm, 24h").optional().describe("Earliest time to leave home/campus, HH:mm (default now)"),
        date,
        plans: z.number().int().min(1).max(5).default(3),
      })),
      annotations: { readOnlyHint: true },
      ...out("CommuteS", CommuteS),
    },
    wrap(async ({ home: homeQ, destination: destQ, direction, time: t, date: d, plans: max }) => {
      const cfg = COMMUTE_DEFAULTS;
      const nowS = nowSec();
      const today = isoDate(nowS);
      const day = d ?? today;
      const base = t ?? hhmm(nowS);
      const baseMin = toMin(base);
      const dir = direction === "auto" ? (baseMin < 13 * 60 ? "to_gent" : "to_brussels") : direction;
      const live = day === today && Math.abs(baseMin - toMin(hhmm(nowS))) <= 60;
      const baseMs = brusselsLocalToEpoch(`${day}T${base}:00`) * 1000;

      const [home, campus, stibAll, sbl, gspCands] = await Promise.all([
        resolveAny(env, homeQ, "stib"),
        resolveAny(env, destQ, "delijn"),
        stibStops(env),
        stib(env, "static/stopsByLine", DAY).then((r) => r.data),
        delijnCandidates(env, "Gent Sint-Pietersstation"),
      ]);
      const midiStib = stibAll.find((s) => s.id === "stib:GARE DU MIDI");
      const gsp = gspCands.find((s) => s.name === "Gent Sint-Pietersstation");
      if (!midiStib || !gsp) throw new ToolError("UPSTREAM_ERROR", "Couldn't load the Midi metro or Gent Sint-Pietersstation bus stops.", "Retry once in a few seconds.");
      const gspPts = gsp.points ?? [];
      const campusPts = campus.points ?? pointsFromId(campus.id);
      const lines = await delijnLines(env, [...gspPts, ...campusPts]);
      const MIDI = "BE.NMBS.008814001";
      const GSP = "BE.NMBS.008892007";

      // De Lijn trips origin → destination for the day, with live delays merged in when relevant.
      const busTrips = async (from: Stop, fromPts: string[], to: Stop, toPts: string[]) => {
        const [o, dst] = await Promise.all([
          delijnKern(env, `haltes/lijst/${fromPts.join("_")}/dienstregelingen?datum=${day}`, 3_600),
          delijnKern(env, `haltes/lijst/${toPts.join("_")}/dienstregelingen?datum=${day}`, 3_600),
        ]);
        let items = mapDoorkomsten(o.data, from, lines, Date.now(), baseMs - 60_000, undefined, baseMs + 4 * 3_600_000);
        if (live) {
          try {
            const rt = await delijnKern(env, `haltes/lijst/${fromPts.join("_")}/real-time?maxAantalDoorkomsten=10`, 20);
            const byTrip = new Map(mapDoorkomsten(rt.data, from, lines, Date.now()).map((x) => [x.tripKey, x]));
            items = items.map((x) => {
              const l = byTrip.get(x.tripKey);
              return l ? { ...x, realtimeTime: l.realtimeTime, delayMin: l.delayMin, cancelled: l.cancelled, ts: l.ts, live: l.live } : x;
            });
          } catch {
            // live data down: timetable only
          }
        }
        return keepTripsTo(items, mapDoorkomsten(dst.data, to, lines, Date.now(), 0, new Set(items.map((x) => x.tripKey!))));
      };

      const warnings: string[] = [];
      const addWarnings = async (metroLineLabels: string[], dlBuses: string[]) => {
        await Promise.allSettled([
          (async () => {
            const r = await irail(env, "disturbances", { lang: "en" }, 60);
            const stops = await sncbStops(env);
            const sets = stops.filter((s) => s.id === MIDI || s.id === GSP).flatMap((s) => stopKeywordSets(s));
            mapDisturbances(r.data)
              .filter((x) => x.type === "incident" && mentionsStop(`${x.title} ${x.description}`, sets))
              .forEach((x) => warnings.push(`SNCB: ${x.title}`));
          })(),
          (async () => {
            const r = await stib(env, "rt/TravellersInformation", 60);
            mapTravellersInfo(r.data)
              // STIB tags some tram notices with metro lines too; keep only texts that actually mention the metro.
              .filter((n) => n.type === "incident" && n.lines.some((l) => metroLineLabels.includes(l)) && /\bm(e|é)tro\b|\bM ?[1256]\b/i.test(n.description))
              .forEach((n) => warnings.push(`STIB ${n.lines.filter((l) => metroLineLabels.includes(l)).join("/")}: ${n.description.slice(0, 140)}`));
          })(),
          (async () => {
            const r = await delijnKern(env, `haltes/lijst/${[...gspPts, ...campusPts].join("_")}/storingen`, 60);
            mapOmleidingen(r.data, lines)
              .filter((x) => x.type === "incident" && dlBuses.some((b) => x.title.split(" · ")[0].split(" ").includes(b)))
              .forEach((x) => warnings.push(`De Lijn ${x.title}: ${x.description.slice(0, 140)}`));
          })(),
        ]);
      };

      if (dir === "to_gent") {
        const links = metroLinks(sbl, home.points ?? [], midiStib.points ?? []);
        const ride = Math.round(Math.max(...links.map((m) => m.stops), 5) * cfg.metroStopMin);
        const earliestMidi = baseMin + cfg.homeWalkMin + ride + cfg.midiTransferMin;
        const [tr, buses] = await Promise.all([
          irail(env, "connections", { from: MIDI, to: GSP, lang: "en", timesel: "departure", ...irailDateTime(day, fromMin(earliestMidi)), results: "6" }, 30),
          busTrips(gsp, gspPts, campus, campusPts),
        ]);
        let metroLive: MetroLive[] | undefined;
        if (live && links.length) {
          try {
            const pts = links.flatMap((l) => l.fromPoints);
            const r = await stib(env, "rt/WaitingTimes", 20, pointsWhere(pts));
            const want = new Set(links.map((l) => `${l.line}|${l.destination}`));
            metroLive = mapWaitingTimes(r.data, { ...home, points: pts }, Date.now())
              .items.filter((x) => want.has(`${x.line}|${x.destination}`))
              .map((x) => ({ line: x.line, destination: x.destination, inMin: x.inMin ?? 0 }));
          } catch {
            // no live metro: plans fall back to "runs every few min"
          }
        }
        const plans = morningPlans({ trains: mapConnections(tr.data), buses, metro: links, metroLive, homeStop: home.name.split(" / ")[0], campusStop: campus.name, nowMin: baseMin, day, cfg, max });
        await addWarnings([...new Set(links.map((l) => l.line))], [...new Set(buses.map((b) => b.line))]);
        const title = `Commute · ${home.name.split(" / ")[0]} → ${campus.name} · ${day} · ${t ? `leaving from ${base}` : `now ${base}`}`;
        return result(formatCommute(title, plans, "arrive", warnings, staleNote(tr.staleSec)), () =>
          commuteOut({ meta: meta("irail,stib,delijn", Date.now(), tr.staleSec), home, destination: campus, direction: dir, timeTs: baseMs / 1000, dayStartTs: brusselsLocalToEpoch(`${day}T00:00:00`), plans, midi: midiStib, gspBus: gsp, warnings }),
        );
      }

      const links = metroLinks(sbl, midiStib.points ?? [], home.points ?? []);
      const buses = await busTrips(campus, campusPts, gsp, gspPts);
      const firstBus = buses.find((b) => !b.cancelled && b.date === day && toMin(b.realtimeTime) >= baseMin + cfg.campusWalkMin && b.arrivalTime);
      const earliestTrain = firstBus ? toMin(firstBus.arrivalTime!) + cfg.gentTransferMin : baseMin + 20;
      const tr = await irail(env, "connections", { from: GSP, to: MIDI, lang: "en", timesel: "departure", ...irailDateTime(day, fromMin(earliestTrain)), results: "6" }, 30);
      const plans = eveningPlans({ trains: mapConnections(tr.data), buses, metro: links, homeStop: home.name.split(" / ")[0], campusStop: campus.name, nowMin: baseMin, day, cfg, max });
      await addWarnings([...new Set(links.map((l) => l.line))], [...new Set(buses.map((b) => b.line))]);
      const title = `Commute · ${campus.name} → ${home.name.split(" / ")[0]} · ${day} · ${t ? `leaving from ${base}` : `now ${base}`}`;
      return result(formatCommute(title, plans, "arrive", warnings, staleNote(tr.staleSec)), () =>
        commuteOut({ meta: meta("irail,stib,delijn", Date.now(), tr.staleSec), home, destination: campus, direction: dir, timeTs: baseMs / 1000, dayStartTs: brusselsLocalToEpoch(`${day}T00:00:00`), plans, midi: midiStib, gspBus: gsp, warnings }),
      );
    }),
  );

  return server;
}
