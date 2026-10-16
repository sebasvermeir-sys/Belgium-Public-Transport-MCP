// All human/LLM-facing text lives here. Goal: one scannable line per item, no JSON in text.

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
} from "./types";

const delay = (min: number) => (min >= 1 ? ` (+${min})` : min <= -1 ? ` (${min})` : "");
const plat = (p: string | undefined, changed: boolean) =>
  p && p !== "?" ? ` · pl. ${p}${changed ? " (changed)" : ""}` : "";

/** 08:12 (+3) IC 1517 → Gent-Sint-Pieters · pl. 18 (changed) */
export function departureLine(d: Departure, kind: Board["kind"] = "departures"): string {
  const arrow = kind === "arrivals" ? "from" : "→";
  if (d.cancelled) return `${d.scheduledTime} CANCELLED ${d.line} ${arrow} ${d.destination}`;
  const busy = d.occupancy === "high" ? " · busy" : "";
  const gone = d.departed ? " · left" : "";
  return `${d.scheduledTime}${delay(d.delayMin)} ${d.line} ${arrow} ${d.destination}${plat(d.platform, d.platformChanged)}${busy}${gone}`;
}

export function formatBoard(b: Board, note?: string): string {
  const head = `${b.stopName} · ${b.kind} (${b.items.length} of ${b.total})${note ? ` · ${note}` : ""}`;
  if (!b.items.length) return `${head}\nNothing matches. Widen the filter or pick another time.`;
  return [head, ...b.items.map((d) => departureLine(d, b.kind))].join("\n");
}

const pt = (p: JourneyPoint) =>
  p.cancelled ? `${p.scheduledTime} CANCELLED` : `${p.scheduledTime}${delay(p.delayMin)}`;

function legLine(l: JourneyLeg): string {
  if (l.line === "walk") return `   walk to ${l.to.station}`;
  const dir = l.direction ? ` → ${l.direction}` : "";
  const fromPl = l.from.platform ? ` pl. ${l.from.platform}${l.from.platformChanged ? " (changed)" : ""}` : "";
  const toPl = l.to.platform ? ` pl. ${l.to.platform}${l.to.platformChanged ? " (changed)" : ""}` : "";
  return `   ${pt(l.from)} ${l.from.station}${fromPl} · ${l.line}${dir} · arr ${pt(l.to)} ${l.to.station}${toPl}`;
}

export function formatJourneys(js: Journey[], fromName: string, toName: string, note?: string): string {
  if (!js.length) return `${fromName} → ${toName}: no connections found. Try another time or date.`;
  const out = [`${fromName} → ${toName} · ${js.length} options${note ? ` · ${note}` : ""}`];
  js.forEach((j, i) => {
    const changes = j.transfers === 0 ? "direct" : `${j.transfers} change${j.transfers > 1 ? "s" : ""}`;
    const cancelled = j.legs.some((l) => l.from.cancelled || l.to.cancelled) ? " · ⚠ CANCELLED leg" : "";
    out.push(`${i + 1}) ${pt(j.from)} → ${pt(j.to)} · ${j.durationMin} min · ${changes}${cancelled}`);
    if (j.legs.length > 1 || j.legs[0]?.from.platform) j.legs.forEach((l) => out.push(legLine(l)));
    j.alerts.forEach((a) => out.push(`   ⚠ ${a}`));
  });
  return out.join("\n");
}

export function formatTrain(t: TrainStatus): string {
  const head = `${t.line} · ${t.origin} → ${t.destination} · ${t.date} · now${delay(t.currentDelayMin) || " on time"}`;
  const lines = t.stops.map((s) => {
    const mark = s.passed ? "✓" : " ";
    if (s.cancelled) return `${mark} ${s.scheduledTime} CANCELLED ${s.station}`;
    return `${mark} ${s.scheduledTime}${delay(s.delayMin)} ${s.station}${plat(s.platform, s.platformChanged)}`;
  });
  return [head, ...lines].join("\n");
}

export function formatDisruptions(ds: Disruption[], total: number, scope: string): string {
  if (!ds.length) return `No disruptions${scope ? ` for ${scope}` : ""}.`;
  const head = `${ds.length} of ${total} disruptions${scope ? ` for ${scope}` : ""} (incidents first)`;
  return [
    head,
    ...ds.map((d) => {
      const desc = d.description.replace(/\s+/g, " ").trim();
      const short = desc.length > 220 ? `${desc.slice(0, 217)}…` : desc;
      return `[${d.type}] ${d.title}${d.updated ? ` (${d.updated})` : ""}: ${short}`;
    }),
  ].join("\n");
}

export function formatComposition(c: Composition): string {
  if (!c.segments.length) return `${c.vehicleId}: no composition data available.`;
  return c.segments
    .map((s) => {
      const first = s.firstClassUnits.length ? `1st class in car ${s.firstClassUnits.join(", ")}` : "no 1st class";
      const bikes = s.bikeUnits.length ? ` · bikes in car ${s.bikeUnits.join(", ")}` : "";
      const len = s.lengthM > 0 ? `, ${s.lengthM} m` : "";
      return `${c.vehicleId} ${s.origin} → ${s.destination}: ${s.units} cars (${s.materialTypes.join(", ")})${len} · ${first} · seats 1st ${s.seatsFirst} / 2nd ${s.seatsSecond} · toilets in ${s.toiletUnits} cars${bikes}`;
    })
    .join("\n");
}

export function stopLine(s: Stop): string {
  if (s.operator === "delijn") {
    const n = s.points?.length ?? 0;
    return `${s.name} · delijn · ${n} stop${n === 1 ? "" : "s"} · ${s.id}`;
  }
  if (s.operator === "stib") {
    const lines = s.lines?.length ? ` · ${s.lines.join(" ")}` : "";
    return `${s.name} · stib${lines} · ${s.id}`;
  }
  const alt = s.names.filter((n) => n !== s.name);
  return `${s.name}${alt.length ? ` (${alt.join(" / ")})` : ""} · ${s.operator} · ${s.id}`;
}

/**
 * STIB live board, one line per line+destination:
 * M2 → Simonis · 3, 9, 15 min
 * B71 → Delta · 12 min (last)
 */
export function formatStibBoard(
  stopName: string,
  now: string,
  items: Departure[],
  ended: string[],
  limit: number,
  note?: string,
): string {
  const groups = new Map<string, Departure[]>();
  for (const d of items) {
    const k = `${d.line} → ${d.destination}`;
    groups.set(k, [...(groups.get(k) ?? []), d]);
  }
  const rows = [...groups].slice(0, limit).map(([k, ds]) => {
    const mins = ds.slice(0, 3).map((d) => (d.inMin === 0 ? "now" : String(d.inMin)));
    const unit = mins.at(-1) === "now" ? "" : " min";
    const last = ds.some((d) => d.note === "last") ? " (last)" : "";
    return `${k} · ${mins.join(", ")}${unit}${last}`;
  });
  const head = `${stopName} · STIB live · now ${now} (${rows.length} of ${groups.size})${note ? ` · ${note}` : ""}`;
  const out = [head, ...rows];
  if (ended.length) out.push(`No live departures now (service ended or not running): ${ended.join(" ")}`);
  if (!rows.length && !ended.length) out.push("No departures right now. Widen the filter, or check disruptions.");
  return out.join("\n");
}

/**
 * De Lijn board, one line per line+destination with scheduled time and live delay:
 * B555 → Zelzate · 07:59 (+2), 08:29 · first in 4 min
 * Times marked * are timetable only (no live data).
 */
export function formatDelijnBoard(stopName: string, header: string, items: Departure[], limit: number, live: boolean, note?: string): string {
  if (items.some((d) => d.arrivalTime)) return formatDelijnTrips(stopName, header, items, limit, live, note);
  const groups = new Map<string, Departure[]>();
  for (const d of items) {
    const k = `${d.line} → ${d.destination}`;
    groups.set(k, [...(groups.get(k) ?? []), d]);
  }
  let anySched = false;
  const rows = [...groups].slice(0, limit).map(([k, ds]) => {
    const times = ds.slice(0, 3).map((d) => {
      if (d.cancelled) return `${d.scheduledTime} CANCELLED`;
      const star = live && d.note === "sched" ? "*" : "";
      if (star) anySched = true;
      return `${d.scheduledTime}${delay(d.delayMin)}${star}`;
    });
    const first = ds.find((d) => !d.cancelled);
    const inMin = live && first ? ` · ${first.inMin === 0 ? "now" : `in ${first.inMin} min`}` : "";
    return `${k} · ${times.join(", ")}${inMin}`;
  });
  const head = `${stopName} · De Lijn ${header} (${rows.length} of ${groups.size})${note ? ` · ${note}` : ""}`;
  const out = [head, ...rows];
  if (!rows.length) out.push(live ? "No departures in the next hour. Try a time (timetable) or check disruptions." : "No departures at that time.");
  if (anySched) out.push("* = timetable only, no live position");
  return out.join("\n");
}

/**
 * De Lijn A → B, one line per trip in time order:
 * 08:05 B55 (dir. Zelzate Busstation) · arr 08:13
 */
function formatDelijnTrips(stopName: string, header: string, items: Departure[], limit: number, live: boolean, note?: string): string {
  const rows = items.slice(0, limit).map((d) => {
    if (d.cancelled) return `${d.scheduledTime} CANCELLED ${d.line} (dir. ${d.destination})`;
    const inMin = live ? ` · ${d.inMin === 0 ? "now" : `in ${d.inMin} min`}` : "";
    return `${d.scheduledTime}${delay(d.delayMin)} ${d.line} (dir. ${d.destination}) · arr ${d.arrivalTime}${inMin}`;
  });
  const head = `${stopName} · De Lijn ${header} (${rows.length} of ${items.length} trips)${note ? ` · ${note}` : ""}`;
  return [head, ...rows].join("\n");
}
