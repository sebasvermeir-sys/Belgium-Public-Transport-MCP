// CPU per tools/call through the real Worker (fixtures, no network). Run: npm run profile
// Reports cold (first call in a fresh module) and warm (median of later calls) CPU ms per case.

import { it } from "vitest";
import { CASES } from "../test/cases";
import { call, ENV } from "../test/helpers/harness";

const cpu = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

it.runIf(process.env.PROFILE)("profile", { timeout: 300_000 }, async () => {
  const rows: string[] = [];
  for (const token of [ENV.MCP_TOKEN, ENV.APP_TOKEN]) {
    for (const c of CASES) {
      const runs: number[] = [];
      for (let i = 0; i < 11; i++) {
        const t0 = cpu();
        await call(c.tool, c.args, c.at, token);
        runs.push(cpu() - t0);
      }
      const sorted = runs.slice(1).sort((a, b) => a - b);
      const warm = sorted[0];
      const p50 = sorted[5];
      rows.push(`${token === ENV.MCP_TOKEN ? "chat" : "semm"} ${c.name.padEnd(30)} first ${runs[0].toFixed(1).padStart(6)} ms  min ${warm.toFixed(1).padStart(5)} ms  median ${p50.toFixed(1).padStart(5)} ms`);
    }
  }
  console.log(rows.join("\n"));
});
