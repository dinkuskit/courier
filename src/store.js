/**
 * Where the courier runs in a store: `courierScheduled()` from the Cloudflare
 * Worker's `scheduled()` handler, which the store's once-a-minute timer calls.
 * It reaches EmDash through `withEmDashRuntime()`, EmDash's own entry point for
 * work outside a request, so a run needs nobody signed in. (A Node store's way
 * to run it waits until self-hosted stores are supported.)
 */

import { runCourier } from "./index.js";

let running = null;

function logReport(report) {
  if (!report) return;
  for (const problem of report.problems) {
    const where = [problem.plugin, problem.route, problem.from, problem.topic].filter(Boolean).join(" ");
    console.warn(`[courier] ${problem.code}: ${where}`);
  }
  if (report.unfinished) console.warn("[courier] more news is waiting; the next run carries it");
}

/**
 * One courier run against the store's EmDash runtime. A run already going in
 * this process is shared instead of starting a second one. Never rejects.
 */
export function courierTick(options = {}) {
  if (running) return running;
  running = (async () => {
    const withRuntime = options.withEmDashRuntime ?? (await import("emdash/middleware")).withEmDashRuntime;
    const report = await withRuntime((runtime) => runCourier(runtime, options));
    logReport(report);
    return report;
  })()
    .catch((error) => {
      console.warn("[courier] the run failed:", error instanceof Error ? error.message : String(error));
      return null;
    })
    .finally(() => {
      running = null;
    });
  return running;
}

/**
 * A Worker `scheduled()` handler, or a step to call from one:
 * `scheduled: courierScheduled()`, or `courierScheduled()(controller, env, ctx)`.
 */
export function courierScheduled(options = {}) {
  return (_controller, _env, ctx) => {
    const run = courierTick(options);
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(run);
    return run;
  };
}
