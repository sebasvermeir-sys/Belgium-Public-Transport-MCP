// Structured output contract: every tool's structuredContent validates against its outputSchema (schema_version 1),
// the text stays identical to the chat's, and the chat token never gets structured data.

import { describe, expect, it } from "vitest";
import worker from "../src/index";
import {
  BoardS,
  CommuteS,
  CompositionS,
  DisruptionsS,
  disruptionOut,
  ErrorS,
  FindStopS,
  isoAt,
  PlanJourneyS,
  TrainStatusS,
} from "../src/structured";
import { CASES } from "./cases";
import { call, ENV, listTools } from "./helpers/harness";

const SCHEMAS: Record<string, any> = {
  find_stop: FindStopS,
  departures: BoardS,
  arrivals: BoardS,
  plan_journey: PlanJourneyS,
  train_status: TrainStatusS,
  disruptions: DisruptionsS,
  composition: CompositionS,
  commute_check: CommuteS,
};
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

/** Every string value under a key ending in a time name must be ISO with offset. */
function checkTimes(v: unknown, path = ""): void {
  if (Array.isArray(v)) return v.forEach((x, i) => checkTimes(x, `${path}[${i}]`));
  if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      if (k === "platform") continue; // platform.scheduled is a platform number, not a time
      if (["scheduled", "expected", "fetched_at", "valid_from", "valid_until", "leave_by", "arrive_at", "time"].includes(k) && typeof x === "string")
        expect(x, `${path}.${k}`).toMatch(ISO_RE);
      else checkTimes(x, `${path}.${k}`);
    }
}

/** Every stop object must have real coordinates. */
function checkStops(v: unknown): void {
  if (Array.isArray(v)) return v.forEach(checkStops);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("operator" in o && "lat" in o && "lon" in o && "id" in o) {
      // Belgium bounds: catches swapped or missing coordinates.
      expect(o.lat, `${o.id} lat`).toBeGreaterThanOrEqual(49.4);
      expect(o.lat, `${o.id} lat`).toBeLessThanOrEqual(51.6);
      expect(o.lon, `${o.id} lon`).toBeGreaterThanOrEqual(2.5);
      expect(o.lon, `${o.id} lon`).toBeLessThanOrEqual(6.5);
    }
    Object.values(o).forEach(checkStops);
  }
}

describe("Structured output (APP_TOKEN)", () => {
  for (const c of CASES)
    it(c.name, { timeout: 20_000 }, async () => {
      const [chat, sem] = [await call(c.tool, c.args, c.at), await call(c.tool, c.args, c.at, ENV.APP_TOKEN)];
      expect(sem.text).toBe(chat.text); // same text for both callers
      expect(chat.isError || chat.structured === undefined).toBe(true); // chat: no structured payload on success
      expect(sem.structured, JSON.stringify(sem.raw).slice(0, 300)).toBeDefined();
      const schema = sem.isError ? ErrorS : SCHEMAS[c.tool];
      const parsed = schema.safeParse(sem.structured);
      expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
      checkTimes(sem.structured);
      checkStops(sem.structured);
      if (!sem.isError) expect(sem.structured.meta.schema_version).toBe("1");
    });

  it("tools/list: outputSchema only for APP_TOKEN", async () => {
    const [chat, sem] = [await listTools(), await listTools(ENV.APP_TOKEN)];
    expect(chat.every((t) => !t.outputSchema)).toBe(true);
    expect(sem.map((t) => t.name).sort()).toEqual(chat.map((t) => t.name).sort());
    expect(sem.every((t) => t.outputSchema?.type === "object")).toBe(true);
  });

  it("rejects unknown tokens", async () => {
    const res = await worker.fetch(
      new Request("https://x/mcp", { method: "POST", headers: { Authorization: "Bearer nope" }, body: "{}" }),
      ENV as any,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });
});

describe("Structured field semantics", () => {
  it("composition uses the same train id format as the other tools", { timeout: 20_000 }, async () => {
    const r = await call("composition", { train_id: "IC1943" }, "2026-10-05T22:10:00+02:00", ENV.APP_TOKEN);
    expect(r.structured.vehicle_id).toBe("IC 1943");
  });

  it("De Lijn stops: search API's swapped coordinates are corrected", { timeout: 20_000 }, async () => {
    const r = await call("find_stop", { query: "Gent Zuid" }, "2026-10-05T19:00:00+02:00", ENV.APP_TOKEN);
    expect(r.structured.stops[0]).toMatchObject({ name: "Gent Zuid", lat: expect.closeTo(51.048, 2), lon: expect.closeTo(3.731, 2) });
  });

  it("SNCB departures: ISO, delay, platform object, vehicle id", { timeout: 20_000 }, async () => {
    const r = await call("departures", { stop: "Bruxelles-Midi", limit: 6 }, "2026-10-05T19:00:00+02:00", ENV.APP_TOKEN);
    const d = r.structured.departures;
    expect(r.structured.stop).toMatchObject({ id: "BE.NMBS.008814001", operator: "sncb" });
    expect(d[0]).toMatchObject({ operator: "sncb", mode: "train", line: "IC", vehicle_id: "IC 1943", direction: "Tournai", realtime: true, cancelled: false });
    expect(d[0].scheduled).toBe("2026-10-05T22:14:00+02:00");
    expect(d[0].platform).toEqual({ scheduled: "19", actual: "19", changed: false });
    const late = d.find((x: any) => x.delay_min === 3)!;
    expect(Date.parse(late.expected) - Date.parse(late.scheduled)).toBe(180_000);
    const keys = d.map((x: any) => Date.parse(x.expected));
    expect([...keys].sort((a, b) => a - b)).toEqual(keys); // flat, sorted by expected
  });

  it("STIB departures: scheduled null, expected absolute, no platform", { timeout: 20_000 }, async () => {
    const r = await call("departures", { stop: "Trône" }, "2026-10-06T00:40:10+02:00", ENV.APP_TOKEN);
    const m6 = r.structured.departures.find((x: any) => x.line === "M6");
    expect(m6).toMatchObject({ operator: "stib", mode: "metro", direction: "Elisabeth", scheduled: null, delay_min: null, realtime: true, platform: null });
    expect(m6.expected).toMatch(/^2026-10-06T00:42/);
    expect(r.structured.ended_lines).toContain("M2");
  });

  it("De Lijn with to: arrival_at_to", { timeout: 20_000 }, async () => {
    const r = await call("departures", { stop: "Sint-Pietersstation", operator: "delijn", to: "Gent Zuid", time: "07:57", date: "2026-10-06" }, "2026-10-06T01:05:00+02:00", ENV.APP_TOKEN);
    const b55 = r.structured.departures.find((x: any) => x.line === "B55");
    expect(r.structured.to.name).toBe("Gent Zuid");
    expect(b55).toMatchObject({ realtime: false, expected: null, delay_min: null, scheduled: "2026-10-06T08:05:00+02:00" });
    expect(b55.arrival_at_to).toMatchObject({ scheduled: "2026-10-06T08:20:00+02:00", realtime: false });
  });

  it("plan_journey: legs with platforms and stop coordinates", { timeout: 20_000 }, async () => {
    const r = await call("plan_journey", { from: "Gent-Sint-Pieters", to: "midi", time: "18:00", date: "2026-10-05" }, "2026-10-05T17:30:00+02:00", ENV.APP_TOKEN);
    const j = r.structured.journeys[0];
    expect(r.structured.query.from).toMatchObject({ id: "BE.NMBS.008892007", lat: expect.closeTo(51.0359, 3), lon: expect.closeTo(3.7107, 3) });
    expect(j.departure).toMatchObject({ scheduled: "2026-10-05T18:00:00+02:00", expected: "2026-10-05T18:03:00+02:00", delay_min: 3, realtime: true });
    expect(j.legs[0]).toMatchObject({ mode: "train", operator: "sncb", line: "IC", vehicle_id: "IC 1517", direction: "Hasselt", transfer_before: null });
    expect(j.legs[0].departure.platform).toEqual({ scheduled: "11", actual: "11", changed: false });
    const changed = r.structured.journeys[2].legs[0].arrival.platform;
    expect(changed).toEqual({ scheduled: null, actual: "8", changed: true }); // iRail doesn't give the original platform
  });

  it("commute_check: metro → train → bus with transfers", { timeout: 20_000 }, async () => {
    const r = await call("commute_check", { home: "Botanique", destination: "Gent Zuid", direction: "to_gent", time: "08:00", date: "2026-10-06" }, "2026-10-05T23:00:00+02:00", ENV.APP_TOKEN);
    const j = r.structured.journeys[0];
    expect(j.legs.map((l: any) => `${l.mode}:${l.operator}`)).toEqual(["metro:stib", "train:sncb", "bus:delijn"]);
    expect(j.leave_by).toBe("2026-10-06T08:05:00+02:00");
    expect(j.arrive_at).toBe("2026-10-06T09:20:00+02:00");
    expect(j.legs[1].transfer_before).toMatchObject({ scheduled_min: 6 }); // metro arrives in time for the 08:29 train
    expect(j.legs[2].transfer_before).toMatchObject({ scheduled_min: 5, expected_min: 5 }); // 08:57 → bus 09:02
    expect(j.legs[2].arrival.scheduled).toBe("2026-10-06T09:15:00+02:00");
    expect(j.transfers).toBe(2);
    expect(j.legs[0]).toMatchObject({ line: "M2/M6", direction: "Simonis/Roi Baudouin" }); // estimate: both lines named
  });

  it("disruptions: stable ids, types, strike detection", { timeout: 20_000 }, async () => {
    const a = await call("disruptions", { limit: 5 }, "2026-10-05T19:00:00+02:00", ENV.APP_TOKEN);
    const b = await call("disruptions", { limit: 5 }, "2026-10-05T19:05:00+02:00", ENV.APP_TOKEN);
    expect(a.structured.disruptions.map((x: any) => x.id)).toEqual(b.structured.disruptions.map((x: any) => x.id));
    expect(new Set(a.structured.disruptions.map((x: any) => x.id)).size).toBe(a.structured.disruptions.length);
    expect(a.structured.disruptions[0].type).toBe("works");
    const strike = disruptionOut({ operator: "sncb", type: "incident", title: "Grève nationale", description: "Préavis de grève le 14/10", updated: "" }, []);
    expect(strike).toMatchObject({ type: "strike", severity: "major" });
    const staking = disruptionOut({ operator: "delijn", type: "planned", title: "Staking", description: "Door een staking rijden minder bussen", updated: "" }, []);
    expect(staking.type).toBe("strike");
    const stib = await call("disruptions", { station: "Trône", limit: 4 }, "2026-10-06T00:40:00+02:00", ENV.APP_TOKEN);
    expect(stib.structured.disruptions[0].id).toMatch(/^stib:\d+$/);
    expect(stib.structured.disruptions[0].stops.length).toBeGreaterThan(0);
  });

  it("errors: code, retryable, candidates with coordinates", { timeout: 20_000 }, async () => {
    const r = await call("departures", { stop: "Antwerpen", operator: "sncb" }, "2026-10-05T19:00:00+02:00", ENV.APP_TOKEN);
    expect(r.isError).toBe(true);
    expect(r.structured.error).toMatchObject({ code: "STOP_AMBIGUOUS", retryable: false });
    expect(r.structured.error.candidates[0]).toMatchObject({ name: "Antwerpen-Berchem", operator: "sncb", lat: expect.any(Number) });
  });

  it("isoAt uses the Brussels offset in summer and winter", () => {
    expect(isoAt(Date.parse("2026-10-09T11:51:00Z") / 1000)).toBe("2026-10-09T13:51:00+02:00");
    expect(isoAt(Date.parse("2026-12-09T11:51:00Z") / 1000)).toBe("2026-12-09T12:51:00+01:00");
  });
});

describe("exact display names from earlier results resolve", () => {
  it("commute_check accepts home \"Botanique / Kruidtuin\" (the name find_stop returns)", { timeout: 20_000 }, async () => {
    const r = await call("commute_check", { home: "Botanique / Kruidtuin", destination: "Gent Zuid", direction: "to_gent", time: "08:00", date: "2026-10-06", plans: 1 }, "2026-10-05T23:00:00+02:00", ENV.APP_TOKEN);
    expect(r.isError, r.text).toBe(false);
    expect(r.structured.query.home.id).toBe("stib:BOTANIQUE");
  });
});
