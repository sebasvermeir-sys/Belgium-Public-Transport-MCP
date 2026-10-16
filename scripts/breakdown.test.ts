import { readFileSync } from "node:fs";
import { it } from "vitest";
import { buildServer } from "../src/server";
import { mapStations } from "../src/providers/sncb";
import { mapStibStops, mapTravellersInfo } from "../src/providers/stib";
import { groupSearch, lineIndex, mapDoorkomsten } from "../src/providers/delijn";
import { searchStops } from "../src/stops";
import { call, ENV } from "../test/helpers/harness";

const fx = (n: string) => readFileSync(`test/fixtures/${n}.json`, "utf8");
const t = (label: string, fn: () => unknown, n = 20) => {
  fn();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn();
  console.log(`${label.padEnd(44)} ${((performance.now() - t0) / n).toFixed(2)} ms`);
};

it.runIf(process.env.PROFILE)("breakdown", { timeout: 300_000 }, async () => {
  t("buildServer chat", () => buildServer(ENV as any));
  t("buildServer structured", () => buildServer(ENV as any, { structured: true }));
  const st = [fx("irail_stations_en"), fx("irail_stations_nl"), fx("irail_stations_fr")];
  t("parse 3x iRail stations", () => st.map((s) => JSON.parse(s)));
  const parsed = st.map((s) => JSON.parse(s));
  t("mapStations", () => mapStations(parsed[0], parsed[1], parsed[2]));
  const sd = fx("stib_stopdetails"), sbl = fx("stib_stopsbyline");
  t("parse STIB stopDetails+byLine", () => [JSON.parse(sd), JSON.parse(sbl)]);
  const sdj = JSON.parse(sd), sblj = JSON.parse(sbl);
  t("mapStibStops", () => mapStibStops(sdj, sblj));
  const all = [...mapStations(parsed[0], parsed[1], parsed[2]), ...mapStibStops(sdj, sblj)];
  const js = JSON.stringify(all);
  t(`parse all stops from KV (${(js.length / 1024) | 0} KB)`, () => JSON.parse(js));
  for (const q of ["midi", "Bourse", "Gent Zuid", "Gent-Sint-Pieters", "Antwerpen"]) t(`searchStops "${q}"`, () => searchStops(all, q));
  const ti = fx("stib_travellersinfo");
  t(`parse+map STIB TravellersInfo (${(ti.length / 1024) | 0} KB)`, () => mapTravellersInfo(JSON.parse(ti)));
  const dg = fx("delijn_dienst_sintpieters"), dh = fx("delijn_dienst_zuid"), le = fx("delijn_lines_e2");
  t(`parse De Lijn dienst GSP (${(dg.length / 1024) | 0} KB)`, () => JSON.parse(dg));
  t(`parse De Lijn dienst Gent Zuid (${(dh.length / 1024) | 0} KB)`, () => JSON.parse(dh));
  t(`parse+index De Lijn lines (${(le.length / 1024) | 0} KB)`, () => lineIndex(JSON.parse(le)));
  const [gsp] = groupSearch(JSON.parse(fx("delijn_search_sintpieters")));
  const lines = lineIndex(JSON.parse(le));
  const dgj = JSON.parse(dg);
  t("mapDoorkomsten GSP", () => mapDoorkomsten(dgj, gsp, lines, 0, 0));
  const dist = fx("irail_disturbances");
  t(`parse iRail disturbances (${(dist.length / 1024) | 0} KB)`, () => JSON.parse(dist));
  const p0 = performance.now();
  for (let i = 0; i < 10; i++) await call("composition", { train_id: "IC 1943" }, "2026-10-05T22:10:00+02:00");
  console.log(`${"full call: composition (baseline)".padEnd(44)} ${((performance.now() - p0) / 10).toFixed(2)} ms`);
});
