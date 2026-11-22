/**
 * Where the courier runs in a store.
 *
 * - Cloudflare: `courierScheduled()` from the Worker's `scheduled()` handler,
 *   which the store's once-a-minute timer calls.
 * - Node: `courierOnVisit()` from the site's middleware, which starts a run on
 *   any page visit, at most once a minute, without delaying the page.
 *
 * Both reach EmDash through `withEmDashRuntime()`, EmDash's own entry point for
 * work outside a request, so a run needs nobody signed in.
 */

import { runCourier } from "./index.js";

const EVERY_MS = 60_000;

let running = null;
let nextVisitRunAt = 0;

function onCloudflare() {
  return typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
}

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

/**
 * An Astro middleware that starts a courier run on a visit at most once a
 * minute in this process, after the page is answered. It does nothing on
 * Cloudflare, where the timer runs the courier.
 */
export function courierOnVisit(options = {}) {
  const everyMs = options.everyMs ?? EVERY_MS;
  return async (_context, next) => {
    const now = Date.now();
    if (!onCloudflare() && now >= nextVisitRunAt) {
      nextVisitRunAt = now + everyMs;
      const later = options.after ?? (await import("emdash")).after;
      later(() => courierTick(options).then(() => {}));
    }
    return next();
  };
}
