// Machine-readable output for apps (structuredContent + outputSchema, schema_version "1").
// Only sent to callers using APP_TOKEN; the chat keeps the compact text from format.ts.
// Conventions: ISO 8601 times with the Brussels offset; every stop has lat/lon; time objects carry
// scheduled / expected / delay_min / realtime; platforms are { scheduled, actual, changed } or null.

import { z } from "zod";
import type { Plan } from "./commute";
import { brusselsParts, offsetMin } from "./time";
import type { ToolError } from "./errors";
import type { Composition, Departure, Disruption, Journey, JourneyLeg, JourneyPoint, Operator, Stop, TrainStatus } from "./types";

// ---------- time ----------
/** unix seconds -> "2026-10-09T13:51:00+02:00" */
export function isoAt(ts: number): string {
  const t = Math.floor(ts);
  const p = brusselsParts(t);
  const off = offsetMin(t);
  const sign = off >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const mm = String(Math.abs(off) % 60).padStart(2, "0");
  return `${p.y}-${p.m}-${p.d}T${p.hh}:${p.mm}:${p.ss}${sign}${hh}:${mm}`;
}
const isoOrNull = (ts?: number | null) => (ts == null || Number.isNaN(ts) ? null : isoAt(ts));

// ---------- schemas ----------
const ISO = z.string().describe("ISO 8601 with Brussels offset");
const OPERATOR = z.enum(["sncb", "stib", "delijn"]);
const MODE = z.enum(["train", "metro", "tram", "bus", "walk"]);

export const StopS = z.object({ id: z.string(), name: z.string(), operator: OPERATOR, lat: z.number(), lon: z.number() });
export const TimeS = z.object({
  scheduled: ISO.nullable(),
  expected: ISO.nullable(),
  delay_min: z.number().int().nullable(),
  realtime: z.boolean(),
});
export const PlatformS = z.object({ scheduled: z.string().nullable(), actual: z.string().nullable(), changed: z.boolean() });
export const TimePlatS = TimeS.extend({ platform: PlatformS.nullable() });
export const MetaS = z.object({
  schema_version: z.literal("1"),
  source: z.string().describe('"irail", "stib", "delijn" or a comma list'),
  fetched_at: ISO,
  stale: z.boolean().describe("true = upstream down, served from a cached copy"),
});
export const AlertS = z.object({ title: z.string(), description: z.string().nullable(), url: z.string().nullable() });

export const DepartureS = z.object({
  operator: OPERATOR,
  mode: MODE,
  line: z.string(),
  direction: z.string(),
  scheduled: ISO.nullable(),
  expected: ISO.nullable(),
  delay_min: z.number().int().nullable(),
  realtime: z.boolean(),
  platform: PlatformS.nullable(),
  cancelled: z.boolean(),
  vehicle_id: z.string().nullable(),
  arrival_at_to: TimeS.nullable(),
});
export const BoardS = z.object({
  meta: MetaS,
  stop: StopS,
  to: StopS.nullable(),
  departures: z.array(DepartureS),
  ended_lines: z.array(z.string()).describe("STIB: lines serving the stop with no live departures now"),
});

export const TransferS = z.object({ at: StopS, scheduled_min: z.number().int().nullable(), expected_min: z.number().int().nullable() });
export const LegS = z.object({
  mode: MODE,
  operator: OPERATOR.nullable(),
  line: z.string().nullable(),
  vehicle_id: z.string().nullable(),
  direction: z.string().nullable(),
  from: StopS,
  to: StopS,
  departure: TimePlatS,
  arrival: TimePlatS,
  cancelled: z.boolean(),
  transfer_before: TransferS.nullable().describe("Time to change before this leg; negative expected_min = connection broken"),
});
export const JourneyS = z.object({
  departure: TimeS,
  arrival: TimeS,
  duration_min: z.number().int(),
  transfers: z.number().int(),
  cancelled: z.boolean(),
  legs: z.array(LegS),
  alerts: z.array(AlertS),
});
export const PlanJourneyS = z.object({
  meta: MetaS,
  query: z.object({ from: StopS, to: StopS, time: ISO.nullable(), arrive_by: z.boolean() }),
  journeys: z.array(JourneyS),
});
export const CommuteS = z.object({
  meta: MetaS,
  query: z.object({ home: StopS, destination: StopS, direction: z.enum(["to_gent", "to_brussels"]), time: ISO }),
  journeys: z.array(
    JourneyS.extend({
      leave_by: ISO.describe("When to start walking"),
      arrive_at: ISO.describe("Arrival at the final destination, walk included (estimate)"),
    }),
  ),
  warnings: z.array(z.string()),
});

export const TrainStatusS = z.object({
  meta: MetaS,
  vehicle_id: z.string(),
  origin: z.string(),
  destination: z.string(),
  cancelled: z.boolean(),
  stops: z.array(z.object({ stop: StopS, arrival: TimePlatS.nullable(), departure: TimePlatS.nullable(), cancelled: z.boolean(), passed: z.boolean() })),
});

export const DisruptionS = z.object({
  id: z.string().describe("Stable across calls"),
  operator: OPERATOR,
  type: z.enum(["strike", "works", "incident", "info"]),
  severity: z.enum(["info", "minor", "major"]),
  title: z.string(),
  description: z.string(),
  lines: z.array(z.string()),
  stops: z.array(StopS),
  valid_from: ISO.nullable(),
  valid_until: ISO.nullable(),
  url: z.string().nullable(),
});
export const DisruptionsS = z.object({ meta: MetaS, total: z.number().int(), disruptions: z.array(DisruptionS) });

export const FindStopS = z.object({
  meta: MetaS,
  stops: z.array(
    StopS.extend({
      names: z.object({ fr: z.string().nullable(), nl: z.string().nullable(), en: z.string().nullable() }),
      lines: z.array(z.string()),
    }),
  ),
});

export const CompositionS = z.object({
  meta: MetaS,
  vehicle_id: z.string(),
  segments: z.array(
    z.object({
      origin: z.string(),
      destination: z.string(),
      cars: z.number().int(),
      length_m: z.number().nullable(),
      material_types: z.array(z.string()),
      first_class_cars: z.array(z.number().int()),
      bike_cars: z.array(z.number().int()),
      seats_first: z.number().int(),
      seats_second: z.number().int(),
      toilet_cars: z.number().int(),
    }),
  ),
});

export const ErrorS = z.object({
  error: z.object({
    code: z.enum(["STOP_AMBIGUOUS", "STOP_NOT_FOUND", "UPSTREAM_UNAVAILABLE", "UPSTREAM_TIMEOUT", "NO_RESULTS", "BAD_INPUT"]),
    message: z.string(),
    retryable: z.boolean(),
    candidates: z.array(StopS),
  }),
});

// ---------- builders ----------
export function meta(source: string, nowMs: number, staleSec?: number) {
  return { schema_version: "1" as const, source, fetched_at: isoAt(Math.floor(nowMs / 1000) - (staleSec ?? 0)), stale: !!staleSec };
}

export const stopOut = (s: { id: string; name: string; operator: Operator; lat?: number; lon?: number }) => ({
  id: s.id,
  name: s.name,
  operator: s.operator,
  lat: s.lat ?? 0,
  lon: s.lon ?? 0,
});

const platform = (p: string | undefined, changed: boolean) =>
  p && p !== "?" ? { scheduled: changed ? null : p, actual: p, changed } : null;

/** Time object from scheduled ts + delay. */
function time(schedTs: number | undefined, delayMin: number | null, realtime: boolean) {
  const sched = schedTs ?? null;
  return {
    scheduled: isoOrNull(sched),
    expected: realtime && sched != null ? isoAt(sched + (delayMin ?? 0) * 60) : null,
    delay_min: realtime ? (delayMin ?? 0) : null,
    realtime,
  };
}

export function departureOut(d: Departure) {
  const live = d.live ?? true;
  const sncb = d.operator === "sncb";
  const base = d.schedTs != null ? time(d.schedTs, d.delayMin, live) : { scheduled: null, expected: isoOrNull(d.ts), delay_min: null, realtime: live };
  return {
    operator: d.operator,
    mode: d.mode,
    line: sncb ? d.line.split(" ")[0] : d.line,
    direction: d.destination,
    ...base,
    platform: platform(d.platform, d.platformChanged),
    cancelled: d.cancelled,
    vehicle_id: sncb ? d.line : null,
    arrival_at_to:
      d.arrivalTs != null
        ? { scheduled: isoAt(d.arrivalTs - d.delayMin * 60), expected: live ? isoAt(d.arrivalTs) : null, delay_min: live ? d.delayMin : null, realtime: live }
        : null,
  };
}

/** Flat list sorted by expected (or scheduled) time, at most `max` items (the earliest). */
export function boardOut(m: ReturnType<typeof meta>, stop: Stop, items: Departure[], ended: string[] = [], to?: Stop, max = Infinity) {
  const key = (d: Departure) => d.ts ?? d.schedTs ?? 0;
  return {
    meta: m,
    stop: stopOut(stop),
    to: to ? stopOut(to) : null,
    departures: [...items].sort((a, b) => key(a) - key(b)).slice(0, max).map(departureOut),
    ended_lines: ended,
  };
}

const pointStop = (p: JourneyPoint) => stopOut({ id: p.stationId, name: p.station, operator: "sncb", lat: p.lat, lon: p.lon });
const pointTime = (p: JourneyPoint) => ({ ...time(p.schedTs, p.delayMin, true), platform: platform(p.platform, p.platformChanged) });
const expTs = (p: JourneyPoint) => (p.schedTs ?? 0) + p.delayMin * 60;

type LegOut = z.infer<typeof LegS>;
type TransferOut = z.infer<typeof TransferS>;

function legOut(l: JourneyLeg, prev?: JourneyLeg): LegOut {
  const walk = l.line === "walk";
  return {
    mode: walk ? ("walk" as const) : ("train" as const),
    operator: walk ? null : ("sncb" as const),
    line: walk ? null : (l.lineType ?? l.line.split(" ")[0]),
    vehicle_id: walk ? null : l.line,
    direction: l.direction ?? null,
    from: pointStop(l.from),
    to: pointStop(l.to),
    departure: pointTime(l.from),
    arrival: pointTime(l.to),
    cancelled: l.from.cancelled || l.to.cancelled,
    transfer_before: prev
      ? {
          at: pointStop(l.from),
          scheduled_min: Math.round(((l.from.schedTs ?? 0) - (prev.to.schedTs ?? 0)) / 60),
          expected_min: Math.round((expTs(l.from) - expTs(prev.to)) / 60),
        }
      : null,
  };
}

export function journeyOut(j: Journey) {
  return {
    departure: time(j.from.schedTs, j.from.delayMin, true),
    arrival: time(j.to.schedTs, j.to.delayMin, true),
    duration_min: j.durationMin,
    transfers: j.transfers,
    cancelled: j.legs.some((l) => l.from.cancelled || l.to.cancelled),
    legs: j.legs.map((l, i) => legOut(l, j.legs[i - 1])),
    alerts: j.alerts.map((a) => ({ title: a, description: null, url: null })),
  };
}

export function trainOut(m: ReturnType<typeof meta>, t: TrainStatus) {
  const ev = (e?: { schedTs: number; delayMin: number; cancelled: boolean; platform?: string; platformChanged: boolean }) =>
    e ? { ...time(e.schedTs, e.delayMin, true), platform: platform(e.platform, e.platformChanged) } : null;
  return {
    meta: m,
    vehicle_id: t.line,
    origin: t.origin,
    destination: t.destination,
    cancelled: t.stops.length > 0 && t.stops.every((s) => s.cancelled),
    stops: t.stops.map((s) => ({
      stop: stopOut({ id: s.stationId, name: s.station, operator: "sncb", lat: s.lat, lon: s.lon }),
      arrival: ev(s.arrival),
      departure: ev(s.departure),
      cancelled: s.cancelled,
      passed: s.passed,
    })),
  };
}

const STRIKE = /\b(gr[eè]ve|staking|stakingen|strike|strikes|stakingsdag|actiedag|pr[ée]avis)\b/i;
const WORKS = /\b(works?|travaux|werken|werkzaamheden)\b|working on the track/i;
const MAJOR = /interrupt|interrompu|onderbroken|no (trains?|metros?|trams?|bus(es)?)|cancel|supprim|geschrapt|afgeschaft|not served|replaced by|replaces all|vervangen|remplac/i;
const URLS: Record<Operator, string> = {
  sncb: "https://www.belgiantrain.be/en/travel-info/current-traffic-situation",
  stib: "https://www.stib-mivb.be/en/traffic-info",
  delijn: "https://www.delijn.be/nl/storingen/",
};

export function disruptionOut(d: Disruption, stops: Stop[]) {
  const text = `${d.title} ${d.description}`;
  const type = STRIKE.test(text) ? "strike" : WORKS.test(text) || d.type === "planned" ? "works" : d.type === "incident" ? "incident" : "info";
  const severity = type === "strike" ? "major" : MAJOR.test(text) ? (type === "works" ? "minor" : "major") : type === "incident" ? "minor" : "info";
  return {
    id: d.id ?? `${d.operator}:unknown`,
    operator: d.operator,
    type: type as "strike" | "works" | "incident" | "info",
    severity: severity as "info" | "minor" | "major",
    title: d.title,
    description: d.description.replace(/\s+/g, " ").trim(),
    lines: d.lines ?? [],
    stops: stops.map(stopOut),
    valid_from: isoOrNull(d.validFrom),
    valid_until: isoOrNull(d.validUntil),
    url: d.link ?? URLS[d.operator],
  };
}

export function findStopOut(m: ReturnType<typeof meta>, stops: Stop[]) {
  return {
    meta: m,
    stops: stops.map((s) => ({
      ...stopOut(s),
      names: { fr: s.namesByLang?.fr ?? null, nl: s.namesByLang?.nl ?? null, en: s.namesByLang?.en ?? null },
      lines: s.lines ?? [],
    })),
  };
}

export function compositionOut(m: ReturnType<typeof meta>, c: Composition) {
  return {
    meta: m,
    vehicle_id: c.vehicleId.replace(/^([A-Z]+)(\d+)$/, "$1 $2"), // "IC1943" -> "IC 1943", like the other tools
    segments: c.segments.map((s) => ({
      origin: s.origin,
      destination: s.destination,
      cars: s.units,
      length_m: s.lengthM > 0 ? s.lengthM : null,
      material_types: s.materialTypes,
      first_class_cars: s.firstClassUnits,
      bike_cars: s.bikeUnits,
      seats_first: s.seatsFirst,
      seats_second: s.seatsSecond,
      toilet_cars: s.toiletUnits,
    })),
  };
}

export function errorOut(e: ToolError) {
  const code =
    e.code === "NOT_FOUND"
      ? "NO_RESULTS"
      : e.code === "UPSTREAM_ERROR" || e.code === "UPSTREAM_RATE_LIMITED"
        ? "UPSTREAM_UNAVAILABLE"
        : e.code;
  const notConfigured = /not configured|rejected our API key/.test(e.message);
  const cands = (e.data?.candidates as Stop[] | undefined) ?? [];
  return {
    error: {
      code: code as z.infer<typeof ErrorS>["error"]["code"],
      message: `${e.message} ${e.nextStep}`.trim(),
      retryable: (code === "UPSTREAM_UNAVAILABLE" || code === "UPSTREAM_TIMEOUT") && !notConfigured,
      candidates: cands.map((c) => stopOut({ ...c, operator: c.operator ?? "sncb" })),
    },
  };
}

// ---------- commute ----------
export function commuteOut(o: {
  meta: ReturnType<typeof meta>;
  home: Stop;
  destination: Stop;
  direction: "to_gent" | "to_brussels";
  timeTs: number;
  dayStartTs: number; // unix s of 00:00 Brussels on the plan day
  plans: Plan[];
  midi: Stop; // STIB Gare du Midi
  gspBus: Stop; // De Lijn Gent Sint-Pietersstation
  warnings: string[];
}) {
  const at = (min: number) => isoAt(o.dayStartTs + Math.round(min * 60));
  const journeys = o.plans.map((p) => {
    const legs: LegOut[] = [];
    const metroLeg = (from: Stop, to: Stop, depMin: number, arrMin: number): LegOut => ({
      mode: "metro" as const,
      operator: "stib" as const,
      line: p.metro?.line ?? null,
      vehicle_id: null,
      direction: p.metro?.destination ?? null,
      from: stopOut(from),
      to: stopOut(to),
      // Live metro: expected = live time. Otherwise an estimate: scheduled = latest/earliest boarding time, not realtime.
      departure: p.metro?.live
        ? { scheduled: null, expected: at(depMin), delay_min: null, realtime: true, platform: null }
        : { scheduled: at(depMin), expected: null, delay_min: null, realtime: false, platform: null },
      arrival: { scheduled: p.metro?.live ? null : at(arrMin), expected: p.metro?.live ? at(arrMin) : null, delay_min: null, realtime: !!p.metro?.live, platform: null },
      cancelled: false,
      transfer_before: null,
    });
    const busLeg = (b: Departure, from: Stop, to: Stop): LegOut => {
      const d = departureOut(b);
      return {
        mode: b.mode,
        operator: "delijn" as const,
        line: b.line,
        vehicle_id: null,
        direction: b.destination,
        from: stopOut(from),
        to: stopOut(to),
        departure: { scheduled: d.scheduled, expected: d.expected, delay_min: d.delay_min, realtime: d.realtime, platform: null },
        arrival: { ...(d.arrival_at_to ?? { scheduled: null, expected: null, delay_min: null, realtime: false }), platform: null },
        cancelled: b.cancelled,
        transfer_before: null,
      };
    };
    const train = journeyOut(p.train);
    const minOf = (iso: string | null) => (iso ? (Date.parse(iso) / 1000 - o.dayStartTs) / 60 : null);
    const gap = (later: string | null, earlier: string | null) => {
      const a = minOf(later);
      const b = minOf(earlier);
      return a == null || b == null ? null : Math.round(a - b);
    };
    if (o.direction === "to_gent") {
      const m = metroLeg(o.home, o.midi, p.metro!.depMin, p.metro!.arrMin);
      legs.push(m);
      train.legs.forEach((l, i) => {
        if (i === 0) {
          const arrMetro = m.arrival.expected ?? m.arrival.scheduled;
          l.transfer_before = { at: l.from, scheduled_min: gap(l.departure.scheduled, arrMetro), expected_min: gap(l.departure.expected, arrMetro) };
        }
        legs.push(l);
      });
      if (p.bus) {
        const b = busLeg(p.bus, o.gspBus, o.destination);
        const last = legs[legs.length - 1];
        b.transfer_before = {
          at: b.from,
          scheduled_min: gap(b.departure.scheduled, last.arrival.scheduled),
          expected_min: gap(b.departure.expected ?? b.departure.scheduled, last.arrival.expected),
        };
        legs.push(b);
      }
    } else {
      if (p.bus) legs.push(busLeg(p.bus, o.destination, o.gspBus));
      train.legs.forEach((l, i) => {
        if (i === 0 && legs.length) {
          const prev = legs[legs.length - 1];
          l.transfer_before = {
            at: l.from,
            scheduled_min: gap(l.departure.scheduled, prev.arrival.scheduled),
            expected_min: gap(l.departure.expected, prev.arrival.expected ?? prev.arrival.scheduled),
          };
        }
        legs.push(l);
      });
      const m = metroLeg(o.midi, o.home, p.metro!.depMin, p.metro!.arrMin);
      const last = legs[legs.length - 1];
      m.transfer_before = { at: m.from, scheduled_min: gap(m.departure.scheduled, last.arrival.scheduled), expected_min: gap(m.departure.scheduled, last.arrival.expected) };
      legs.push(m);
    }
    const first = legs[0];
    const lastLeg = legs[legs.length - 1];
    const t0 = first.departure.expected ?? first.departure.scheduled;
    const t1 = lastLeg.arrival.expected ?? lastLeg.arrival.scheduled;
    return {
      departure: { scheduled: first.departure.scheduled, expected: first.departure.expected, delay_min: first.departure.delay_min, realtime: first.departure.realtime },
      arrival: { scheduled: lastLeg.arrival.scheduled, expected: lastLeg.arrival.expected, delay_min: lastLeg.arrival.delay_min, realtime: lastLeg.arrival.realtime },
      duration_min: t0 && t1 ? Math.round((Date.parse(t1) - Date.parse(t0)) / 60_000) : 0,
      transfers: legs.length - 1,
      cancelled: legs.some((l) => l.cancelled),
      legs,
      alerts: train.alerts,
      leave_by: at(p.leaveMin),
      arrive_at: at(p.arriveMin),
    };
  });
  return {
    meta: o.meta,
    query: { home: stopOut(o.home), destination: stopOut(o.destination), direction: o.direction, time: isoAt(o.timeTs) },
    journeys,
    warnings: o.warnings,
  };
}
