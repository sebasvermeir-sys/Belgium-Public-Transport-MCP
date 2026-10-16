import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatDelijnBoard, formatDisruptions, stopLine } from "../src/format";
import { groupSearch, lineIndex, mapDoorkomsten, mapOmleidingen, placeName, pointsFromId } from "../src/providers/delijn";
import { mapStations } from "../src/providers/sncb";
import { resolveStop } from "../src/stops";
import { brusselsLocalToEpoch } from "../src/time";

const fx = (n: string) => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", `${n}.json`), "utf8"));
const lines = lineIndex(fx("delijn_lines_e2"));
const [zuid] = groupSearch(fx("delijn_search_zuid"));
const [gsp] = groupSearch(fx("delijn_search_sintpieters"));

describe("De Lijn helpers", () => {
  it("parses Brussels local times across DST", () => {
    expect(brusselsLocalToEpoch("2026-10-06T08:12:00")).toBe(Date.parse("2026-10-06T08:12:00+02:00") / 1000);
    expect(brusselsLocalToEpoch("2026-12-01T08:12:00")).toBe(Date.parse("2026-12-01T08:12:00+01:00") / 1000);
  });
  it("derives place names", () => {
    expect(placeName("Gent Sint-Pietersstation perron 14")).toBe("Gent Sint-Pietersstation");
    expect(placeName("Gent Rabot (Begijnhoflaan)")).toBe("Gent Rabot");
  });
  it("maps internal line numbers to public labels", () => {
    expect(lines.get("2_555")).toEqual({ label: "B55", mode: "bus" });
    expect(lines.get("2_765")?.label).toBe("B76");
    expect(lines.get("2_1")).toEqual({ label: "T4", mode: "tram" });
    expect(lines.get("2_98")?.label).toBe("B9b");
  });
});

describe("De Lijn stops", () => {
  it("groups platforms into one place", () => {
    expect(zuid.name).toBe("Gent Zuid");
    expect(zuid.points).toEqual(expect.arrayContaining(["2_200065", "2_204810", "2_200393"]));
    expect(gsp.name).toBe("Gent Sint-Pietersstation");
    expect(gsp.points).toHaveLength(16);
    expect(pointsFromId(zuid.id)).toEqual(zuid.points);
    expect(stopLine(zuid)).toBe(`Gent Zuid · delijn · 10 stops · ${zuid.id}`);
  });

  it("resolves alongside SNCB without stealing the train station", () => {
    const sncb = mapStations(fx("irail_stations_en"), fx("irail_stations_nl"), fx("irail_stations_fr"));
    const all = [...sncb, zuid, gsp];
    expect(resolveStop(all, "Gent Zuid").id).toBe(zuid.id);
    expect(resolveStop(all, "Gent-Sint-Pieters").id).toBe("BE.NMBS.008892007");
    expect(resolveStop(all, "Sint-Pietersstation", "delijn").id).toBe(gsp.id);
  });
});

describe("De Lijn departures", () => {
  it("live: scheduled time, live delay, minutes", () => {
    const now = Date.parse("2026-10-16T19:14:00+02:00");
    const ds = mapDoorkomsten(fx("delijn_realtime_zuid"), zuid, lines, now);
    expect(ds.length).toBeGreaterThan(0);
    const b33 = ds.find((d) => d.destination === "Destelbergen Damvalleistraat")!;
    expect(b33).toMatchObject({ operator: "delijn", line: "B33", mode: "bus", scheduledTime: "19:01", realtimeTime: "19:17", delayMin: 17 });
    const text = formatDelijnBoard(zuid.name, "live · now 19:14", ds, 10, true);
    expect(text).toMatch(/^Gent Zuid · De Lijn live · now 19:14/);
    expect(text).toMatch(/B33 → Destelbergen Damvalleistraat · 19:01 \(\+17\)/);
  });

  it("timetable from a given time, for the commute (bus 55 at Gent Zuid)", () => {
    const from = Date.parse("2026-10-06T08:05:00+02:00");
    const ds = mapDoorkomsten(fx("delijn_dienst_zuid"), zuid, lines, from - 7 * 3600_000, from);
    expect(ds.every((d) => `${d.date} ${d.scheduledTime}` >= "2026-10-06 08:05")).toBe(true);
    const b55 = ds.filter((d) => d.line === "B55" && d.destination === "Gent Sint-Pietersstation");
    expect(b55[0].scheduledTime).toBe("08:13");
    const text = formatDelijnBoard(zuid.name, "timetable 2026-10-06 from 08:05", ds, 30, false);
    expect(text).toContain("B55 → Gent Sint-Pietersstation · 08:13, 08:49, 09:18");
    expect(text).not.toContain("*");
  });
});

describe("De Lijn disruptions", () => {
  it("maps detours with public line labels, English text and start date", () => {
    const ds = mapOmleidingen(fx("delijn_storingen_zuid"), lines);
    expect(ds[0]).toMatchObject({ operator: "delijn", type: "incident", title: "B40 · Unexpected disruption", updated: "2026-09-11 18:14" });
    expect(ds[0].description).toMatch(/^No tram T1 or T3/);
    expect(formatDisruptions(ds, ds.length, "Gent Zuid")).toContain("[incident] B40 · Unexpected disruption (2026-09-11 18:14)");
  });
});

describe("De Lijn A → B (to)", () => {
  it("keeps only trips that later stop at the destination, with arrival times", async () => {
    const { keepTripsTo } = await import("../src/providers/delijn");
    const from = Date.parse("2026-10-06T07:57:00+02:00");
    const origin = mapDoorkomsten(fx("delijn_dienst_sintpieters"), gsp, lines, from - 7 * 3600_000, from);
    const dest = mapDoorkomsten(fx("delijn_dienst_zuid"), zuid, lines, 0, 0);
    const ds = keepTripsTo(origin, dest);
    const b55 = ds.find((d) => d.line === "B55")!;
    expect(b55).toMatchObject({ scheduledTime: "08:05", arrivalTime: "08:20", destination: "Zelzate Busstation" });
    // Opposite direction (Gent Zuid comes before the station) is dropped.
    expect(ds.some((d) => d.tripKey === "2026-10-06_2775_10")).toBe(false);
    const text = formatDelijnBoard(gsp.name, "timetable 2026-10-06 from 07:57 · to Gent Zuid", ds, 6, false);
    expect(text).toContain("08:05 B55 (dir. Zelzate Busstation) · arr 08:20");
    expect(text).toMatch(/^08:00 B77 \(dir\. .*\) · arr 08:15$/m);
  });
});

describe("fast Brussels time conversion around DST switches", () => {
  it("local -> epoch and back", async () => {
    const { hhmm, isoDate } = await import("../src/time");
    const cases: [string, string][] = [
      ["2026-10-25T01:59:00", "2026-10-25T01:59:00+02:00"], // before fall-back
      ["2026-10-25T03:30:00", "2026-10-25T03:30:00+01:00"], // after fall-back
      ["2026-03-29T01:30:00", "2026-03-29T01:30:00+01:00"], // before spring-forward
      ["2026-03-29T03:30:00", "2026-03-29T03:30:00+02:00"], // after spring-forward
      ["2026-12-31T23:59:30", "2026-12-31T23:59:30+01:00"],
    ];
    for (const [local, iso] of cases) {
      const ts = brusselsLocalToEpoch(local);
      expect(ts, local).toBe(Date.parse(iso) / 1000);
      expect(hhmm(ts)).toBe(local.slice(11, 16));
      expect(isoDate(ts)).toBe(local.slice(0, 10));
    }
    expect(Number.isNaN(brusselsLocalToEpoch("garbage"))).toBe(true);
  });
});
