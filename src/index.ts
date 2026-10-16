// Worker entry: bearer-token gate in front of the stateless MCP handler on /mcp.
// Auth: "Authorization: Bearer <token>" (claude.ai Request headers), or the fallback path /mcp/<token>.
// Two tokens: MCP_TOKEN (chat: text only) and the optional APP_TOKEN (apps/dashboards: text + structuredContent).
// Another Worker on the same account can also call through a Service Binding; it still sends its bearer token.

import { createMcpHandler } from "agents/mcp/server";
import { buildServer, buildSncbStops, buildStibStops, type Env } from "./server";

// Must match wrangler.jsonc "triggers.crons".
const CRON_SNCB = "17 */6 * * *";
const CRON_STIB = "47 */6 * * *";

async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

const unauthorized = () =>
  new Response(JSON.stringify({ error: "unauthorized", message: "Missing or wrong bearer token." }), {
    status: 401,
    headers: { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer realm="belgian-transit"' },
  });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") return new Response("belgian-transit-mcp ok");
    if (!env.MCP_TOKEN) return new Response("Server misconfigured: MCP_TOKEN secret not set.", { status: 500 });

    // Which caller is this? null = no valid token.
    const who = async (token: string): Promise<"chat" | "app" | null> => {
      if (!token) return null;
      if (await sameSecret(token, env.MCP_TOKEN)) return "chat";
      if (env.APP_TOKEN && (await sameSecret(token, env.APP_TOKEN))) return "app";
      return null;
    };

    let req = request;
    let caller: "chat" | "app" | null;
    if (url.pathname.startsWith("/mcp/")) {
      // Fallback for clients that can't send headers: secret in the path.
      caller = await who(url.pathname.slice(5));
      if (!caller) return unauthorized();
      url.pathname = "/mcp";
      req = new Request(url, request);
    } else if (url.pathname === "/mcp") {
      const auth = request.headers.get("Authorization") ?? "";
      caller = await who(auth.startsWith("Bearer ") ? auth.slice(7).trim() : "");
      if (!caller) return unauthorized();
    } else {
      return new Response("Not found", { status: 404 });
    }

    return createMcpHandler(() => buildServer(env, { structured: caller === "app" }))(req, env, ctx);
  },

  // Rebuild the stop lists into KV outside user requests (see "stop lists" in src/server.ts).
  // One list per cron so each run stays well under the CPU limit.
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === CRON_SNCB) ctx.waitUntil(buildSncbStops(env));
    else if (event.cron === CRON_STIB && env.BELGIAN_MOBILITY_KEY) ctx.waitUntil(buildStibStops(env));
  },
} satisfies ExportedHandler<Env>;
