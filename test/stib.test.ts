import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatDisruptions, formatStibBoard, stopLine } from "../src/format";
import { mapStations } from "../src/providers/sncb";
import { lineLabel, lineMode, mapStibStops, mapTravellersInfo, mapWaitingTimes, pointKey, titleCase } from "../src/providers/stib";
import { pointsWhere } from "../src/stib";
import { resolveStop, searchStops } from "../src/stops";

const fx = (n: string) => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", `${n}.json`), "utf8"));
const stops = mapStibStops(fx("stib_stopdetails"), fx("stib_stopsbyline"));
const sncb = mapStations(fx("irail_stations_en"), fx("irail_stations_nl"), fx("irail_stations_fr"));
const all = [...sncb, ...stops];
const byId = (id: string) => stops.find((s) => s.id === id)!;
// Waiting-times fixture was captured at 2026-10-06 00:40 Brussels (end of the service day).
const NOW = Date.parse("2026-10-06T00:40:10+02:00");

describe("STIB helpers", () => {
  it("labels lines by mode", () => {
    expect(["2", "6", "71", "81", "T81", "39", "T39", "12"].map(lineLabel)).toEqual(["M2", "M6", "B71", "T81", "T81", "T39", "T39", "B12"]);
    expect(lineMode("1")).toBe("metro");
    expect(lineMode("93")).toBe("tram");
  });
  it("strips point suffixes and title-cases names", () => {
    expect(pointKey("5088F")).toBe("5088");
    expect(titleCase("GARE DU MIDI")).toBe("Gare du Midi");
    expect(titleCase("PORTE DE NAMUR")).toBe("Porte de Namur");
  });
  it("builds a where clause for points", () => {
    expect(pointsWhere(["8301", "8302"])).toBe('pointid in ("8301","8302")');
  });
});

describe("STIB stops", () => {
  it("groups platforms under one stop with FR/NL names and lines", () => {
    const trone = byId("stib:TRONE");
    expect(trone.name).toBe("Trone / Troon");
    expect(trone.points).toEqual(expect.arrayContaining(["8301", "8302", "1780", "6432", "6433"]));
    expect(trone.lines).toEqual(expect.arrayContaining(["M2", "M6", "B12"]));
    const bourse = byId("stib:BOURSE");
    expect(bourse.names).toEqual(["Bourse", "Beurs"]);
    expect(bourse.lines).toEqual(expect.arrayContaining(["T4", "T10", "B46", "B89"]));
    expect(stops.length).toBeGreaterThan(800);
  });

  it.each([
    ["Trône", "stib:TRONE"],
    ["troon", "stib:TRONE"],
    ["Bourse", "stib:BOURSE"],
    ["Beurs", "stib:BOURSE"],
    ["midi metro", "stib:GARE DU MIDI"],
    ["Zuidstation", "stib:GARE DU MIDI"],
    ["Porte de Namur", "stib:PORTE DE NAMUR"],
  ])("resolves %s across SNCB+STIB", (q, id) => {
    expect(resolveStop(all, q).id).toBe(id);
  });

  it("midi alone still means the train station; operator stib picks the metro stop", () => {
    expect(resolveStop(all, "midi").id).toBe("BE.NMBS.008814001");
    expect(resolveStop(all, "midi", "stib").id).toBe("stib:GARE DU MIDI");
  });

  it("find_stop line shows lines", () => {
    const [m] = searchStops(all, "Bourse", "stib");
    expect(stopLine(m.stop)).toMatch(/^Bourse \/ Beurs · stib · .*T4.* · stib:BOURSE$/);
  });
});

describe("STIB waiting times", () => {
  const trone = byId("stib:TRONE");
  const { items, ended } = mapWaitingTimes(fx("stib_waitingtimes"), trone, NOW);

  it("maps live passings at the stop's points only, soonest first", () => {
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((d) => trone.points!.length && d.stopId === "stib:TRONE")).toBe(true);
    const m6 = items.find((d) => d.line === "M6")!;
    expect(m6).toMatchObject({ mode: "metro", destination: "Elisabeth", note: "last", realtimeTime: "00:42", inMin: 3 });
    const mins = items.map((d) => d.inMin!);
    expect([...mins].sort((a, b) => a - b)).toEqual(mins);
  });

  it("reports lines whose service ended", () => {
    expect(ended).toContain("M2");
    expect(ended).not.toContain("M6");
  });

  it("formats one compact line per line+direction", () => {
    const text = formatStibBoard(trone.name, "00:40", items, ended, 10);
    expect(text).toMatch(/^Trone \/ Troon · STIB live · now 00:40/);
    expect(text).toContain("M6 → Elisabeth · 3 min (last)");
    expect(text).toMatch(/B21 → Bordet Station · 10, 11, 30 min/);
    expect(text).toContain("No live departures now (service ended or not running): M2");
    expect(text.split("\n").length).toBeLessThanOrEqual(12);
  });
});

describe("STIB travellers information", () => {
  const ns = mapTravellersInfo(fx("stib_travellersinfo"));
  it("maps notices with lines, points and type", () => {
    expect(ns.length).toBeGreaterThan(100);
    const t51 = ns.find((n) => n.lines.includes("T51") && /BELGICA/.test(n.description))!;
    expect(t51.type).toBe("planned");
    expect(t51.description).toMatch(/^Works\. Until December 2026/);
  });
  it("formats without empty timestamps", () => {
    const text = formatDisruptions(ns.slice(0, 2), ns.length, "Bourse");
    expect(text).not.toContain("()");
    expect(text.split("\n")[1]).toMatch(/^\[(planned|incident)\] /);
  });
});

describe("exact stop names resolve (no STOP_AMBIGUOUS for the stop itself)", () => {
  it.each([
    ["Trone / Troon", "stib:TRONE"],
    ["trône / troon", "stib:TRONE"],
    ["TRONE/TROON", "stib:TRONE"],
    ["Gare du Midi / Zuidstation", "stib:GARE DU MIDI"],
    ["Bourse / Beurs", "stib:BOURSE"],
  ])("%s", (q, id) => {
    expect(resolveStop(stops, q, "stib").id).toBe(id);
    expect(resolveStop(all, q).id).toBe(id);
  });
});
