import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMMUTE_DEFAULTS, eveningPlans, formatCommute, morningPlans, toMin } from "../src/commute";
import { groupSearch, keepTripsTo, lineIndex, mapDoorkomsten } from "../src/providers/delijn";
import { mapConnections } from "../src/providers/sncb";
import { mapStibStops, metroLinks } from "../src/providers/stib";
import type { Journey, JourneyPoint } from "../src/types";

const fx = (n: string) => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", `${n}.json`), "utf8"));
const stib = mapStibStops(fx("stib_stopdetails"), fx("stib_stopsbyline"));
const home = stib.find((s) => s.id === "stib:BOTANIQUE")!;
const midi = stib.find((s) => s.id === "stib:GARE DU MIDI")!;
const lines = lineIndex(fx("delijn_lines_e2"));
const [zuid] = groupSearch(fx("delijn_search_zuid"));
const [gsp] = groupSearch(fx("delijn_search_sintpieters"));
const dienst = (n: string, st: typeof gsp) => mapDoorkomsten(fx(n), st, lines, 0, 0);

const pt = (station: string, time: string, delay = 0, platform?: string): JourneyPoint => ({
  station,
  stationId: "",
  scheduledTime: time,
  realtimeTime: `${String(Math.floor((toMin(time) + delay) / 60)).padStart(2, "0")}:${String((toMin(time) + delay) % 60).padStart(2, "0")}`,
  delayMin: delay,
  platform,
  platformChanged: false,
  cancelled: false,
});
const train = (dep: string, arr: string, line: string, dir: string, delay = 0, platform = "11"): Journey => {
  const from = pt("Brussel-Zuid/Bruxelles-Midi", dep, delay, platform);
  const to = pt("Gent-Sint-Pieters", arr, delay, "12");
  return { date: "2026-10-06", from, to, durationMin: toMin(arr) - toMin(dep), transfers: 0, legs: [{ line, direction: dir, from, to }], alerts: [] };
};

describe("metro links from line order", () => {
  it("Botanique → Midi is M2 (Simonis) / M6 (Roi Baudouin), 8 stops; reverse goes to Elisabeth", () => {
    const am = metroLinks(fx("stib_stopsbyline"), home.points!, midi.points!);
    expect(am.map((l) => `${l.line}|${l.destination}|${l.stops}`).sort()).toEqual(["M2|Simonis|8", "M6|Roi Baudouin|8"]);
    const pm = metroLinks(fx("stib_stopsbyline"), midi.points!, home.points!);
    expect(new Set(pm.map((l) => l.destination))).toEqual(new Set(["Elisabeth"]));
  });
});

describe("morning plans", () => {
  const buses = keepTripsTo(dienst("delijn_dienst_sintpieters", gsp), dienst("delijn_dienst_zuid", zuid));
  const metro = metroLinks(fx("stib_stopsbyline"), home.points!, midi.points!);
  const trains = [train("08:29", "08:57", "IC 1530", "Knokke"), train("08:37", "09:06", "IC 430", "Kortrijk", 0, "10"), train("08:59", "09:27", "IC 1531", "Knokke")];
  const base = { buses, metro, homeStop: "Botanique", campusStop: "Gent Zuid", day: "2026-10-06", cfg: COMMUTE_DEFAULTS, max: 3 };

  it("fits metro and bus around each train", () => {
    const plans = morningPlans({ ...base, trains, nowMin: toMin("08:00") });
    expect(plans).toHaveLength(3);
    const [p1] = plans;
    // 08:29 − 6 transfer − 13 ride (8 stops) = metro by 08:10, leave home 08:05
    expect(p1.lines[0]).toBe("08:05 leave for Botanique metro (~5 min walk)");
    expect(p1.lines[1]).toMatch(/^by 08:10 M2\/M6|^by 08:10 M6\/M2/);
    expect(p1.lines[2]).toBe("08:29 IC 1530 → Knokke · Midi pl. 11 → Gent-Sint-Pieters 08:57 pl. 12");
    // ready for a bus at 08:57 + 5 = 09:02 → first trip to Gent Zuid leaving ≥ 09:02 is B71 09:02 (arr 09:15)
    expect(p1.lines[3]).toMatch(/^09:02 B71 .* → Gent Zuid 09:15 · walk 5 min$/);
    expect(p1.arriveMin).toBe(toMin("09:20"));
  });

  it("uses live metro times and drops trains you can no longer make", () => {
    const plans = morningPlans({ ...base, trains, nowMin: toMin("08:12"), metroLive: [{ line: "M6", destination: "Roi Baudouin", inMin: 2 }, { line: "M2", destination: "Simonis", inMin: 6 }] });
    // 08:29 needs leaving at 08:05 → gone; first plan is the 08:37
    expect(plans[0].lines[2]).toMatch(/^08:37 IC 430/);
    // metro by 08:18: latest live metro that still works is M2 in 6 min (08:18)
    expect(plans[0].lines[1]).toBe("08:18 M2 → Simonis · Botanique → Midi (~13 min, live)");
  });

  it("a delayed train shifts the bus", () => {
    const [p] = morningPlans({ ...base, trains: [train("08:29", "08:57", "IC 1530", "Knokke", 9)], nowMin: toMin("08:00") });
    expect(p.lines[2]).toMatch(/^08:29 \(\+9\) IC 1530 .* 08:57 \(\+9\)/);
    // arrives 09:06, ready 09:11 → bus at/after 09:11
    expect(toMin(p.lines[3].slice(0, 5))).toBeGreaterThanOrEqual(toMin("09:11"));
  });
});

describe("evening plans", () => {
  const buses = keepTripsTo(dienst("delijn_dienst_zuid", zuid), dienst("delijn_dienst_sintpieters", gsp));
  const metro = metroLinks(fx("stib_stopsbyline"), midi.points!, home.points!);
  const trains = mapConnections(fx("irail_connections_gent_midi"));

  it("takes the latest bus that still makes each train", () => {
    const plans = eveningPlans({ trains, buses, metro, homeStop: "Botanique", campusStop: "Gent Zuid", nowMin: toMin("17:30"), day: "2026-10-06", cfg: COMMUTE_DEFAULTS, max: 3 });
    expect(plans).toHaveLength(3);
    const p1 = plans[0];
    expect(p1.lines[2]).toMatch(/^18:00 .*Gent-Sint-Pieters.* → Midi /);
    const busArr = p1.lines[1].match(/Gent Sint-Pietersstation (\d\d:\d\d)$/)![1];
    expect(toMin(busArr) + 5).toBeLessThanOrEqual(toMin("18:00"));
    expect(p1.lines[0]).toMatch(/^17:\d\d leave for Gent Zuid \(~5 min walk\)$/);
    // never an after-midnight bus for an 18:00 train
    plans.forEach((p) => expect(p.lines[1]).not.toMatch(/^(2[0-3]|0\d):/));
    expect(p1.lines[3]).toMatch(/M2|M6/);
    expect(p1.lines[3]).toMatch(/arrive ~\d\d:\d\d$/);

    const text = formatCommute("Commute · test", plans, "arrive", ["STIB M2: test warning"]);
    expect(text.split("\n")[0]).toBe("Commute · test · 3 plans");
    expect(text).toContain("Plan 1 · arrive ~");
    expect(text).toContain("⚠ STIB M2: test warning");
    expect(text.split("\n").length).toBeLessThanOrEqual(17);
  });
});
