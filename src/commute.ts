// commute_check planning: pure functions over already-fetched data (trains, metro, buses), so they are testable.
// To Gent: walk → STIB metro → Bruxelles-Midi → SNCB train → Gent-Sint-Pieters → De Lijn bus → destination stop → walk.
// To Brussels: the reverse. Every plan is built around one train; metro and bus are fitted to that train.

import type { Departure, Journey } from "./types";

export interface CommuteCfg {
  homeWalkMin: number; // home → home metro stop
  metroStopMin: number; // per metro stop
  midiTransferMin: number; // metro platform ↔ train platform at Midi
  gentTransferMin: number; // train platform ↔ bus perron at Gent-Sint-Pieters
  campusWalkMin: number; // destination stop ↔ final destination
}

export const COMMUTE_DEFAULTS: CommuteCfg = {
  homeWalkMin: 5,
  metroStopMin: 1.6,
  midiTransferMin: 6,
  gentTransferMin: 5,
  campusWalkMin: 5,
};

export const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
export const fromMin = (n: number) => {
  const x = ((Math.round(n) % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
};
const dl = (n: number) => (n >= 1 ? ` (+${n})` : "");

/** Bus times as minutes since 00:00 of `day`; trips dated the next day (after midnight) get +1440. */
function busTimes(b: Departure, day: string): { dep: number; arr: number } {
  const dep = toMin(b.realtimeTime) + (b.date > day ? 1440 : 0);
  const ride = (toMin(b.arrivalTime ?? b.realtimeTime) - toMin(b.realtimeTime) + 1440) % 1440;
  return { dep, arr: dep + ride };
}

/** Metro lines that run from one STIB stop to another, from stopsByLine order (data-driven, not hardcoded). */
export interface MetroLink {
  line: string; // label "M2"
  destination: string; // terminus, title case
  fromPoints: string[];
  stops: number; // stops between from and to
}

export interface MetroLive {
  line: string;
  destination: string;
  inMin: number;
}

export interface Plan {
  arriveMin: number; // at the final destination, walk included
  leaveMin: number; // when to start walking
  lines: string[];
  catchable: boolean;
  train: Journey;
  bus?: Departure;
  // Metro leg in minutes since 00:00 of the plan day. live = from STIB waiting times; else an estimate.
  metro?: { line: string | null; destination: string | null; depMin: number; arrMin: number; live: boolean };
}

/** "Brussel-Zuid/Bruxelles-Midi" -> "Midi", "Brussel-Centraal/Bruxelles-Central" -> "Central". */
export const shortStation = (n: string) => (n.includes("/") ? n.split("/").pop()!.replace(/^(Bruxelles|Brussels|Brussel)-/, "") : n);

function trainLine(j: Journey): string {
  const first = j.legs.find((l) => l.line !== "walk");
  const name = first ? `${first.line}${first.direction ? ` → ${first.direction}` : ""}` : "train";
  const pl = j.from.platform ? ` pl. ${j.from.platform}${j.from.platformChanged ? " (changed)" : ""}` : "";
  const toPl = j.to.platform ? ` pl. ${j.to.platform}` : "";
  const changes = j.transfers ? ` · ${j.transfers} change${j.transfers > 1 ? "s" : ""}` : "";
  return `${j.from.scheduledTime}${dl(j.from.delayMin)} ${name} · ${shortStation(j.from.station)}${pl} → ${shortStation(j.to.station)} ${j.to.scheduledTime}${dl(j.to.delayMin)}${toPl}${changes}`;
}

const metroName = (links: MetroLink[]) => [...new Set(links.map((l) => l.line))].join("/") || "metro";

/** Plans for the morning. `nowMin` is "now" (or the requested earliest leave time) in minutes. */
export function morningPlans(o: {
  trains: Journey[];
  buses: Departure[]; // Gent-Sint-Pieters → destination stop trips (with arrivalTime), time-ordered
  metro: MetroLink[];
  metroLive?: MetroLive[]; // at the home stop, towards Midi
  homeStop: string;
  campusStop: string;
  nowMin: number;
  day: string; // YYYY-MM-DD the plan is for
  cfg: CommuteCfg;
  max: number;
}): Plan[] {
  const { cfg } = o;
  const ride = Math.round(Math.max(...o.metro.map((m) => m.stops), 5) * cfg.metroStopMin);
  const plans: Plan[] = [];
  for (const j of o.trains) {
    if (plans.length >= o.max) break;
    if (j.from.cancelled) continue;
    const dep = toMin(j.from.realtimeTime);
    const metroBy = dep - cfg.midiTransferMin - ride;
    const leave = metroBy - cfg.homeWalkMin;
    if (leave < o.nowMin) continue; // can't make this train any more
    const lines: string[] = [];
    lines.push(`${fromMin(leave)} leave for ${o.homeStop} metro (~${cfg.homeWalkMin} min walk)`);
    const live = (o.metroLive ?? []).filter((m) => o.nowMin + m.inMin <= metroBy).sort((a, b) => b.inMin - a.inMin)[0];
    lines.push(
      live
        ? `${fromMin(o.nowMin + live.inMin)} ${live.line} → ${live.destination} · ${o.homeStop} → Midi (~${ride} min, live)`
        : `by ${fromMin(metroBy)} ${metroName(o.metro)} ${o.homeStop} → Midi (~${ride} min, runs every few min)`,
    );
    lines.push(trainLine(j));
    const ready = toMin(j.to.realtimeTime) + cfg.gentTransferMin;
    const bus = o.buses.find((b) => !b.cancelled && busTimes(b, o.day).dep >= ready);
    let arrive: number;
    if (bus?.arrivalTime) {
      lines.push(`${bus.scheduledTime}${dl(bus.delayMin)} ${bus.line} (dir. ${bus.destination}) → ${o.campusStop} ${bus.arrivalTime} · walk ${cfg.campusWalkMin} min`);
      arrive = busTimes(bus, o.day).arr + cfg.campusWalkMin;
    } else {
      lines.push(`no bus found to ${o.campusStop} after ${fromMin(ready)}; check departures`);
      arrive = toMin(j.to.realtimeTime) + 20;
    }
    const metroDep = live ? o.nowMin + live.inMin : metroBy;
    plans.push({
      arriveMin: arrive,
      leaveMin: leave,
      lines,
      catchable: true,
      train: j,
      bus: bus?.arrivalTime ? bus : undefined,
      metro: {
        line: live?.line ?? metroName(o.metro),
        destination: live?.destination ?? ([...new Set(o.metro.map((m) => m.destination))].join("/") || null),
        depMin: metroDep,
        arrMin: metroDep + ride,
        live: !!live,
      },
    });
  }
  return plans;
}

/** Plans for the evening: bus to the station, train to Midi, metro home. */
export function eveningPlans(o: {
  trains: Journey[]; // Gent-Sint-Pieters → Midi
  buses: Departure[]; // destination stop → Gent-Sint-Pieters trips (with arrivalTime), time-ordered
  metro: MetroLink[]; // Midi → home stop
  homeStop: string;
  campusStop: string;
  nowMin: number;
  day: string;
  cfg: CommuteCfg;
  max: number;
}): Plan[] {
  const { cfg } = o;
  const ride = Math.round(Math.max(...o.metro.map((m) => m.stops), 5) * cfg.metroStopMin);
  const plans: Plan[] = [];
  for (const j of o.trains) {
    if (plans.length >= o.max) break;
    if (j.from.cancelled) continue;
    const dep = toMin(j.from.realtimeTime);
    const earliestBus = o.nowMin + cfg.campusWalkMin;
    // Latest bus that still makes the train, so you can leave as late as possible.
    const bus = o.buses
      .filter((b) => {
        const bt = busTimes(b, o.day);
        return !b.cancelled && b.arrivalTime && bt.dep >= earliestBus && bt.arr + cfg.gentTransferMin <= dep;
      })
      .at(-1);
    if (!bus) continue;
    const lines = [
      `${fromMin(toMin(bus.realtimeTime) - cfg.campusWalkMin)} leave for ${o.campusStop} (~${cfg.campusWalkMin} min walk)`,
      `${bus.scheduledTime}${dl(bus.delayMin)} ${bus.line} (dir. ${bus.destination}) → Gent Sint-Pietersstation ${bus.arrivalTime}`,
      trainLine(j),
    ];
    const atMetro = toMin(j.to.realtimeTime) + cfg.midiTransferMin;
    const home = atMetro + 3 + ride + cfg.homeWalkMin; // ~3 min average wait for the metro
    lines.push(`${fromMin(atMetro)} ${metroName(o.metro)} Midi → ${o.homeStop} (~${ride} min) · arrive ~${fromMin(home)}`);
    plans.push({
      arriveMin: home,
      leaveMin: toMin(bus.realtimeTime) - cfg.campusWalkMin,
      lines,
      catchable: true,
      train: j,
      bus,
      metro: {
        line: metroName(o.metro),
        destination: [...new Set(o.metro.map((m) => m.destination))].join("/") || null,
        depMin: atMetro,
        arrMin: atMetro + 3 + ride,
        live: false,
      },
    });
  }
  return plans;
}

export function formatCommute(title: string, plans: Plan[], arriveLabel: string, warnings: string[], liveNote?: string): string {
  const out = [`${title} · ${plans.length} plan${plans.length === 1 ? "" : "s"}${liveNote ? ` · ${liveNote}` : ""}`];
  if (!plans.length) out.push("No workable plan found in this window. Try a later time, or check departures/plan_journey.");
  plans.forEach((p, i) => {
    out.push(`Plan ${i + 1} · ${arriveLabel} ~${fromMin(p.arriveMin)}`);
    p.lines.forEach((l) => out.push(`  ${l}`));
  });
  warnings.slice(0, 4).forEach((w) => out.push(`⚠ ${w}`));
  return out.join("\n");
}
