/**
 * A real EmDash runtime on Node's built-in SQLite, with the plugins a test
 * gives it, and the production plugin-route policy boundary for "outside"
 * requests. No Astro, no network.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDialect } from "emdash/db/sqlite";
import { EmDashRuntime, dispatchPluginApiRequest } from "emdash/internal/plugin-test-runtime";

export async function startStore(plugins) {
  const dir = mkdtempSync(join(tmpdir(), "courier-store-"));
  const url = `file:${join(dir, "store.db")}`;
  const runtime = await EmDashRuntime.create({
    config: { database: { entrypoint: `courier-test-${crypto.randomUUID()}`, type: "sqlite", config: { url } } },
    plugins,
    createDialect: () => createDialect({ url }),
    createStorage: null,
    createScheduler: null,
    sandboxEnabled: false,
    sandboxedPluginEntries: [],
  });
  return {
    runtime,
    /** A request from outside the store, through EmDash's own route policy. */
    async outside(pluginId, route, body, user) {
      const response = await dispatchPluginApiRequest({
        runtime,
        pluginId,
        path: `/${route}`,
        request: new Request(`https://store.test/_emdash/api/plugins/${pluginId}/${route}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
          body: JSON.stringify(body),
        }),
        user,
      });
      return { status: response.status, body: await response.json() };
    },
    async stop() {
      try { await runtime.db.destroy(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
