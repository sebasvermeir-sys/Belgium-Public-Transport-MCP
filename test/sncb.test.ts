import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { departureLine, formatBoard, formatComposition, formatDisruptions, formatJourneys, formatTrain } from "../src/format";
import {
  mapComposition,
  mapConnections,
  mapDisturbances,
  mapLiveboard,
  mapStations,
  mapVehicle,
  normalizeTrainId,
} from "../src/providers/sncb";
import { mentionsStop, resolveStop, searchStops, stopKeywordSets } from "../src/stops";
import { irailDateTime } from "../src/time";

const fx = (n: string) => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", `${n}.json`), "utf8"));
const stations = mapStations(fx("irail_stations_en"), fx("irail_stations_nl"), fx("irail_stations_fr"));
const MIDI = "BE.NMBS.008814001";
const GSP = "BE.NMBS.008892007";

describe("stations + stop search", () => {
  it("merges en/nl/fr names", () => {
    const midi = stations.find((s) => s.id === MIDI)!;
    expect(midi.names).toEqual(expect.arrayContaining(["Brussel-Zuid", "Bruxelles-Midi", "Brussels-South/Brussels-Midi"]));
  });

  it.each([
    ["midi", MIDI],
    ["Bruxelles-Midi", MIDI],
    ["Brussel-Zuid", MIDI],
    ["brussels south", MIDI],
    ["Gent St Pieters", GSP],
    ["gent sint piters", GSP], // typo
    ["Gand-Saint-Pierre", GSP],
    ["gent", GSP], // nickname
    ["008814001", MIDI],
  ])("resolves %s", (q, id) => {
    expect(resolveStop(stations, q).id).toBe(id);
  });

  it("aliases point at real stations", () => {
    for (const id of ["BE.NMBS.008813003", "BE.NMBS.008812005"]) expect(stations.some((s) => s.id === id)).toBe(true);
  });

  it("ambiguous query gives candidates and a next step", () => {
    try {
      resolveStop(stations, "Antwerpen");
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe("STOP_AMBIGUOUS");
      expect(e.message).toMatch(/Antwerpen-Centraal/);
      expect(e.nextStep).toMatch(/Call again/);
    }
  });

  it("unknown stop says what to do", () => {
    expect(() => resolveStop(stations, "xqzzv")).toThrow(/No stop matches/);
  });

  it("search returns a short ranked list", () => {
    const m = searchStops(stations, "gent");
    expect(m[0].stop.id).toBe(GSP);
  });
});

describe("liveboard", () => {
  it("maps departures with Brussels times", () => {
    const b = mapLiveboard(fx("irail_liveboard_midi_0720"), "departures");
    expect(b.stopName).toBe("Brussel-Zuid/Bruxelles-Midi");
    const gent = b.items.find((d) => d.destination === "Ghent-Sint-Pieters")!;
    expect(gent).toMatchObject({ scheduledTime: "07:24", line: "IC 2228", platform: "12", cancelled: false, mode: "train" });
    expect(departureLine(gent)).toBe("07:24 IC 2228 → Ghent-Sint-Pieters · pl. 12");
  });

  it("flags platform changes on arrivals", () => {
    const b = mapLiveboard(fx("irail_arrivals_midi"), "arrivals");
    expect(b.items.filter((d) => d.platformChanged).length).toBe(1);
    expect(formatBoard(b)).toMatch(/\(changed\)/);
  });

  it("formats delay and cancellation", () => {
    const b = mapLiveboard(fx("irail_liveboard_midi"), "departures");
    const d = { ...b.items[0], delayMin: 3, platform: "18", platformChanged: true };
    expect(departureLine(d)).toBe(`${d.scheduledTime} (+3) ${d.line} → ${d.destination} · pl. 18 (changed)`);
    expect(departureLine({ ...d, cancelled: true })).toBe(`${d.scheduledTime} CANCELLED ${d.line} → ${d.destination}`);
  });
});

describe("connections", () => {
  it("maps direct trains Gent-Sint-Pieters → Midi around 18:00", () => {
    const js = mapConnections(fx("irail_connections_gent_midi"));
    expect(js.length).toBeGreaterThan(0);
    expect(js[0]).toMatchObject({ transfers: 0, durationMin: 27 });
    expect(js[0].from).toMatchObject({ scheduledTime: "18:00", delayMin: 3, platform: "11" });
    const text = formatJourneys(js, "Gent-Sint-Pieters", "Brussel-Zuid/Bruxelles-Midi");
    expect(text.split("\n")[1]).toBe("1) 18:00 (+3) → 18:28 (+2) · 27 min · direct");
  });

  it("builds legs across vias", () => {
    const js = mapConnections(fx("irail_connections_vias"));
    const j = js.find((x) => x.transfers === 1)!;
    expect(j.legs).toHaveLength(2);
    expect(j.legs[0].to.station).toBe("Brussel-Zuid/Bruxelles-Midi");
    expect(j.legs[1].line).toBe("S8 6567");
    expect(j.legs[1].from).toMatchObject({ platform: "13", platformChanged: true, delayMin: 14 });
  });
});

describe("vehicle / disturbances / composition", () => {
  it("train status", () => {
    const t = mapVehicle(fx("irail_vehicle"));
    expect(t).toMatchObject({ vehicleId: "IC1943", line: "IC 1943", origin: "Brussels Airport - Zaventem", destination: "Tournai" });
    expect(t.stops[0]).toMatchObject({ passed: true, delayMin: 1, platform: "2" });
    expect(formatTrain(t).split("\n")[0]).toMatch(/^IC 1943 · Brussels Airport - Zaventem → Tournai/);
  });

  it("train id normalization", () => {
    expect(normalizeTrainId("BE.NMBS.IC1517")).toBe("IC1517");
    expect(normalizeTrainId("ic 1517")).toBe("IC1517");
  });

  it("disruptions filter by station names incl. abbreviations", () => {
    const ds = mapDisturbances(fx("irail_disturbances"));
    const midi = stations.find((s) => s.id === MIDI)!;
    const sets = stopKeywordSets(midi);
    expect(mentionsStop("Jette - Brux.-Midi/Brus.-Zuid", sets)).toBe(true);
    expect(mentionsStop("Works between Gent-Dampoort and Lokeren", stopKeywordSets(stations.find((s) => s.id === GSP)!))).toBe(false);
    const hits = ds.filter((d) => mentionsStop(`${d.title} ${d.description}`, sets));
    expect(hits.length).toBeGreaterThan(0);
    expect(formatDisruptions(hits.slice(0, 2), hits.length, "Midi")).toMatch(/^2 of \d+ disruptions for Midi/);
  });

  it("composition summary", () => {
    const c = mapComposition(fx("irail_composition"), "IC1943");
    expect(c.segments[0].units).toBe(8);
    expect(formatComposition(c)).toMatch(/^IC1943 Brussels Airport - Zaventem → Tournai: 8 cars/);
  });
});

describe("time", () => {
  it("builds iRail date/time with shift across midnight", () => {
    expect(irailDateTime("2026-10-06", "08:12", -5)).toEqual({ date: "061026", time: "0807" });
    expect(irailDateTime("2026-10-06", "00:02", -5)).toEqual({ date: "051026", time: "2357" });
  });
});
