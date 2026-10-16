// SNCB adapter: iRail API (https://api.irail.be/v1, docs.irail.be). Verified against real responses 2026-10-05.
// Quirks: every value is a string; times are unix seconds; delays are seconds; platforminfo.normal "0" = changed.

import { stableId } from "../hash";
import { delayMin, hhmm, isoDate, isoDateTime, nowSec } from "../time";
import type {
  Board,
  Composition,
  Departure,
  Disruption,
  Journey,
  JourneyLeg,
  JourneyPoint,
  Stop,
  TrainStatus,
} from "../types";

type S = string;
type Json = any; // iRail payloads; validated by mapping + fixture tests

const flag = (v: S | undefined) => v === "1";
const occ = (o: Json): Departure["occupancy"] =>
  ["low", "medium", "high"].includes(o?.name) ? o.name : undefined;

/** "IC1517", "IC 1517", "BE.NMBS.IC1517" -> "IC1517" */
export function normalizeTrainId(id: string): string {
  return id.replace(/^BE\.NMBS\./i, "").replace(/\s+/g, "").toUpperCase();
}

export function mapStations(en: Json, nl: Json, fr: Json): Stop[] {
  const byId = new Map<string, Stop>();
  const langs = ["en", "nl", "fr"] as const;
  for (const [li, list] of [en, nl, fr].entries()) {
    for (const s of list.station as Json[]) {
      const cur: Stop = byId.get(s.id) ?? {
        id: s.id,
        operator: "sncb" as const,
        name: s.standardname,
        names: [] as string[],
        lat: Number(s.locationY),
        lon: Number(s.locationX),
      };
      for (const n of [s.standardname, s.name]) if (n && !cur.names.includes(n)) cur.names.push(n);
      cur.namesByLang = { ...cur.namesByLang, [langs[li]]: s.name };
      byId.set(s.id, cur);
    }
  }
  return [...byId.values()];
}

export function mapLiveboard(j: Json, kind: Board["kind"]): Board {
  const key = kind; // "departures" | "arrivals"
  const rows: Json[] = j[key]?.[key.slice(0, -1)] ?? [];
  const items = rows.map((r): Departure => {
    const t = Number(r.time);
    const dm = delayMin(r.delay);
    return {
      operator: "sncb",
      mode: "train",
      line: r.vehicleinfo?.shortname ?? r.vehicle,
      vehicleId: normalizeTrainId(r.vehicle),
      destination: r.station,
      date: isoDate(t),
      scheduledTime: hhmm(t),
      realtimeTime: hhmm(t + Number(r.delay ?? 0)),
      delayMin: dm,
      schedTs: t,
      ts: t + Number(r.delay ?? 0),
      live: true,
      platform: r.platform || undefined,
      platformChanged: r.platforminfo?.normal === "0",
      cancelled: flag(r.canceled),
      departed: flag(r.left) || flag(r.arrived),
      occupancy: occ(r.occupancy),
      stopId: j.stationinfo.id,
      stopName: j.stationinfo.standardname,
    };
  });
  return { stopId: j.stationinfo.id, stopName: j.stationinfo.standardname, kind, items, total: items.length };
}

function point(p: Json): JourneyPoint {
  const t = Number(p.time);
  return {
    station: p.stationinfo?.standardname ?? p.station,
    stationId: p.stationinfo?.id,
    schedTs: t,
    lat: p.stationinfo?.locationY ? Number(p.stationinfo.locationY) : undefined,
    lon: p.stationinfo?.locationX ? Number(p.stationinfo.locationX) : undefined,
    scheduledTime: hhmm(t),
    realtimeTime: hhmm(t + Number(p.delay ?? 0)),
    delayMin: delayMin(p.delay),
    platform: p.platform || undefined,
    platformChanged: p.platforminfo?.normal === "0",
    cancelled: flag(p.canceled),
  };
}

function leg(dep: Json, arr: Json): JourneyLeg {
  const walking = flag(dep.walking);
  return {
    line: walking ? "walk" : dep.vehicleinfo?.shortname ?? dep.vehicle,
    lineType: walking ? undefined : dep.vehicleinfo?.type,
    vehicleId: walking ? undefined : normalizeTrainId(dep.vehicle ?? ""),
    direction: dep.direction?.name,
    from: point(dep),
    to: point(arr),
  };
}

export function mapConnections(j: Json): Journey[] {
  return (j.connection ?? []).map((c: Json): Journey => {
    const vias: Json[] = c.vias?.via ?? [];
    const legs: JourneyLeg[] = [];
    let dep = c.departure;
    for (const v of vias) {
      legs.push(leg(dep, v.arrival));
      dep = v.departure;
    }
    legs.push(leg(dep, c.arrival));
    const alerts: string[] = (c.alerts?.alert ?? []).map((a: Json) => a.header ?? a.title).filter(Boolean);
    return {
      date: isoDate(Number(c.departure.time)),
      from: point(c.departure),
      to: point(c.arrival),
      durationMin: Math.round(Number(c.duration) / 60),
      transfers: vias.length,
      legs,
      alerts,
    };
  });
}

export function mapVehicle(j: Json): TrainStatus {
  const stops: Json[] = j.stops?.stop ?? [];
  const mapped = stops.map((s, i) => {
    const last = i === stops.length - 1;
    const t = Number(last ? s.scheduledArrivalTime ?? s.time : s.scheduledDepartureTime ?? s.time);
    const d = last ? s.arrivalDelay ?? s.delay : s.departureDelay ?? s.delay;
    const ev = (kind: "Arrival" | "Departure") => {
      const st = s[`scheduled${kind}Time`];
      if (!st || (kind === "Arrival" && i === 0) || (kind === "Departure" && last)) return undefined;
      return {
        schedTs: Number(st),
        delayMin: delayMin(s[`${kind.toLowerCase()}Delay`] ?? s.delay),
        cancelled: flag(s[`${kind.toLowerCase()}Canceled`] ?? s.canceled),
        platform: s.platform || undefined,
        platformChanged: s.platforminfo?.normal === "0",
      };
    };
    return {
      station: s.stationinfo?.standardname ?? s.station,
      stationId: s.stationinfo?.id,
      lat: s.stationinfo?.locationY ? Number(s.stationinfo.locationY) : undefined,
      lon: s.stationinfo?.locationX ? Number(s.stationinfo.locationX) : undefined,
      arrival: ev("Arrival"),
      departure: ev("Departure"),
      scheduledTime: hhmm(t),
      realtimeTime: hhmm(t + Number(d ?? 0)),
      delayMin: delayMin(d),
      platform: s.platform || undefined,
      platformChanged: s.platforminfo?.normal === "0",
      cancelled: flag(last ? s.arrivalCanceled ?? s.canceled : s.departureCanceled ?? s.canceled),
      // iRail doesn't always set left/arrived for trains that ran earlier; fall back to the clock.
      passed: flag(s.left) || (last && flag(s.arrived)) || t + Number(d ?? 0) < nowSec() - 60,
    };
  });
  const lastPassed = [...mapped].reverse().find((s) => s.passed);
  const next = mapped.find((s) => !s.passed);
  return {
    vehicleId: normalizeTrainId(j.vehicle),
    line: j.vehicleinfo?.shortname ?? j.vehicle,
    date: stops[0] ? isoDate(Number(stops[0].time)) : "",
    origin: mapped[0]?.station ?? "",
    destination: mapped.at(-1)?.station ?? "",
    currentDelayMin: (next ?? lastPassed)?.delayMin ?? 0,
    stops: mapped,
  };
}

const distMemo = new WeakMap<object, Disruption[]>();
/** Memoized per raw response object; returns a fresh array (callers sort/filter it). */
export function mapDisturbances(j: Json): Disruption[] {
  let v = distMemo.get(j);
  if (!v) distMemo.set(j, (v = mapDisturbancesUncached(j)));
  return v.slice();
}
function mapDisturbancesUncached(j: Json): Disruption[] {
  return (j.disturbance ?? []).map(
    (d: Json): Disruption => ({
      // iRail's own id is just the list index, so derive a stable one from the content.
      id: stableId("sncb", d.type, d.title, String(d.description ?? "").slice(0, 300)),
      operator: "sncb",
      type: d.type === "planned" ? "planned" : "incident",
      title: d.title,
      description: d.description ?? "",
      link: d.link || undefined,
      updated: isoDateTime(Number(d.timestamp)),
      validFrom: Number(d.timestamp) || undefined,
    }),
  );
}

export function mapComposition(j: Json, vehicleId: string): Composition {
  const segs: Json[] = j.composition?.segments?.segment ?? [];
  return {
    vehicleId,
    segments: segs.map((s) => {
      const units: Json[] = s.composition?.units?.unit ?? [];
      const types = units.map((u) => [u.materialType?.parent_type, u.materialType?.sub_type].filter(Boolean).join(" "));
      const counts = new Map<string, number>();
      types.forEach((t) => counts.set(t, (counts.get(t) ?? 0) + 1));
      const pos = (pred: (u: Json) => boolean) => units.flatMap((u, i) => (pred(u) ? [i + 1] : []));
      const sum = (k: string) => units.reduce((a, u) => a + Number(u[k] ?? 0), 0);
      return {
        origin: s.origin?.standardname ?? s.origin?.name ?? "",
        destination: s.destination?.standardname ?? s.destination?.name ?? "",
        units: units.length,
        materialTypes: [...counts].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)),
        firstClassUnits: pos((u) => Number(u.seatsFirstClass) + Number(u.seatsCoupeFirstClass ?? 0) > 0),
        seatsFirst: sum("seatsFirstClass") + sum("seatsCoupeFirstClass"),
        seatsSecond: sum("seatsSecondClass") + sum("seatsCoupeSecondClass"),
        toiletUnits: units.filter((u) => flag(u.hasToilets)).length,
        bikeUnits: pos((u) => flag(u.hasBikeSection)),
        lengthM: sum("lengthInMeter"),
      };
    }),
  };
}
