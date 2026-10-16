// Calls the real Worker (auth + MCP handler) in-process, with upstream APIs served from test/fixtures and a fixed clock.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import worker from "../../src/index";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const fx = (n: string) => readFileSync(join(dir, `${n}.json`), "utf8");
const json = (body: string) => new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });

// Workers-only API, missing in Node.
const subtle = crypto.subtle as unknown as { timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean };
subtle.timingSafeEqual ??= (a, b) => Buffer.from(a).equals(Buffer.from(b));

export const upstreamCalls: string[] = [];

function fixtureFor(url: URL): Response {
  const p = url.pathname;
  const q = url.searchParams;
  if (url.host === "api.irail.be") {
    const ep = p.split("/").pop();
    if (ep === "stations") return json(fx(`irail_stations_${q.get("lang")}`));
    if (ep === "liveboard") return json(fx(q.get("arrdep") === "arrival" ? "irail_arrivals_midi" : "irail_liveboard_midi"));
    if (ep === "connections") return json(fx(q.get("from") === "BE.NMBS.008814001" ? "irail_connections_midi_gent_synth" : "irail_connections_gent_midi"));
    if (ep === "vehicle") return json(fx("irail_vehicle"));
    if (ep === "composition") return json(fx("irail_composition"));
    if (ep === "disturbances") return json(fx("irail_disturbances"));
  }
  if (p.includes("/stibmivb/")) {
    if (p.endsWith("rt/WaitingTimes")) return json(fx("stib_waitingtimes"));
    if (p.endsWith("rt/TravellersInformation")) return json(fx("stib_travellersinfo"));
    if (p.endsWith("static/stopDetails")) return json(fx("stib_stopdetails"));
    if (p.endsWith("static/stopsByLine")) return json(fx("stib_stopsbyline"));
  }
  if (url.host === "api.delijn.be") {
    const d = decodeURIComponent(p);
    if (d.includes("/zoek/haltes/")) {
      if (/zuid/i.test(d)) return json(fx("delijn_search_zuid"));
      if (/pieters/i.test(d)) return json(fx("delijn_search_sintpieters"));
      return json('{"aantalHits":0,"haltes":[]}');
    }
    if (/entiteiten\/2\/lijnen$/.test(d)) return json(fx("delijn_lines_e2"));
    const zuid = d.includes("2_200065");
    if (d.endsWith("/real-time")) return json(zuid ? fx("delijn_realtime_zuid") : '{"halteDoorkomstenLijst":[]}');
    if (d.endsWith("/dienstregelingen")) return json(fx(zuid ? "delijn_dienst_zuid" : "delijn_dienst_sintpieters"));
    if (d.endsWith("/storingen")) return json(zuid ? fx("delijn_storingen_zuid") : '{"halteOmleidingen":[]}');
  }
  return new Response(`no fixture for ${url}`, { status: 599 });
}

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  upstreamCalls.push(url.href);
  return fixtureFor(url);
}) as typeof fetch;

export const ENV = {
  MCP_TOKEN: "chat-token",
  APP_TOKEN: "app-token",
  IRAIL_USER_AGENT: "test",
  INCLUDE_STRUCTURED: "0",
  BELGIAN_MOBILITY_KEY: "k",
  DELIJN_API_KEY: "k",
};

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
let id = 0;

export interface CallResult {
  text: string;
  isError: boolean;
  structured?: any;
  raw: any;
}

/** tools/call at a fixed Brussels time, e.g. at = "2026-10-06T07:00:00+02:00". */
export async function call(name: string, args: Record<string, unknown>, at: string, token = ENV.MCP_TOKEN): Promise<CallResult> {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(at));
  try {
    const res = await worker.fetch(
      new Request("https://x/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
      }),
      ENV as any,
      ctx,
    );
    const body = await res.text();
    const m = body.match(/^data: (.*)$/m);
    const j = JSON.parse(m ? m[1] : body);
    const r = j.result ?? {};
    return { text: r.content?.[0]?.text ?? JSON.stringify(j.error), isError: !!r.isError, structured: r.structuredContent, raw: j };
  } finally {
    vi.useRealTimers();
  }
}

export async function listTools(token = ENV.MCP_TOKEN): Promise<any[]> {
  const res = await worker.fetch(
    new Request("https://x/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/list", params: {} }),
    }),
    ENV as any,
    ctx,
  );
  const body = await res.text();
  const m = body.match(/^data: (.*)$/m);
  return JSON.parse(m ? m[1] : body).result.tools;
}
