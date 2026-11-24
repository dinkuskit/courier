/**
 * The doors inside EmDash's real Registry sandbox: two plugins built from
 * `@dinkuskit/courier/doors` the way a Registry bundle is (one ES module,
 * `emdash` bundled in), loaded by EmDash's own workerd runner, and reached
 * through EmDash's own route dispatch. Only the courier's personless call
 * reads news or lands it; someone not signed in, the store's administrator,
 * and an administrator's API token are all refused before the plugin's
 * reader or delivery runs.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { WorkerdSandboxRunner } from "@emdash-cms/sandbox-workerd/sandbox";
import { createDialect } from "emdash/db/sqlite";
import { EmDashRuntime, dispatchPluginApiRequest } from "emdash/internal/plugin-test-runtime";
import { rolldown } from "rolldown";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { findDoors, runCourier } from "../src/index.js";

const SENDER = "proof-sender";
const RECEIVER = "proof-receiver";
const DOOR = { methods: ["POST"], public: false, permission: "plugins:manage" };
const admin = { id: "admin", email: "owner@store.test", name: "Owner", role: 50, createdAt: new Date("2026-11-01T00:00:00Z") };

/** One ES module with everything bundled in, as `emdash-plugin build` makes it. */
async function bundle(file) {
  const build = await rolldown({ input: fileURLToPath(new URL(file, import.meta.url)), platform: "browser", logLevel: "silent" });
  try {
    const { output } = await build.generate({ format: "esm", codeSplitting: false });
    if (output.length !== 1) throw new Error("A Registry backend is one module.");
    return output[0].code;
  } finally {
    await build.close();
  }
}

let store;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "courier-registry-"));
  const url = `file:${join(dir, "store.db")}`;
  const entry = async (id, file, door) => ({
    id, version: "1.0.0", code: await bundle(file), capabilities: [], storage: {}, hooks: [],
    routes: [{ name: door, ...DOOR }, { name: "peek", ...DOOR }],
  });
  const runtime = await EmDashRuntime.create({
    config: { database: { entrypoint: `courier-registry-${crypto.randomUUID()}`, type: "sqlite", config: { url } } },
    plugins: [],
    createDialect: () => createDialect({ url }),
    createStorage: null,
    createScheduler: null,
    sandboxEnabled: true,
    createSandboxRunner: (options) => new WorkerdSandboxRunner(options),
    sandboxedPluginEntries: [await entry(SENDER, "./registry/sender.js", "courier/outbox"), await entry(RECEIVER, "./registry/receiver.js", "courier/inbox")],
  });
  store = {
    runtime,
    /** A request from outside the store, through EmDash's own route policy. An API token sends no CSRF header. */
    async outside(pluginId, route, body, { user, tokenScopes } = {}) {
      const headers = { "Content-Type": "application/json", ...(tokenScopes ? { Authorization: "Bearer ec_pat_example" } : { "X-EmDash-Request": "1" }) };
      const response = await dispatchPluginApiRequest({
        runtime, pluginId, path: `/${route}`, user, tokenScopes,
        request: new Request(`https://store.test/_emdash/api/plugins/${pluginId}/${route}`, { method: "POST", headers, body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    },
    /** What each plugin has read and saved so far, asked by the store itself. */
    async peek(pluginId) {
      const answer = await runtime.handlePluginApiRoute(pluginId, "POST", "peek", new Request("https://store.test/", { method: "POST", body: "{}" }));
      expect(answer.success, JSON.stringify(answer.error)).toBe(true);
      return answer.data;
    },
    async stop() {
      try { await runtime.getSandboxRunner()?.terminateAll(); } catch {}
      try { await runtime.db.destroy(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}, 60_000);

afterAll(async () => { await store?.stop(); });

describe("the doors in EmDash's Registry sandbox", () => {
  test("both plugins run sandboxed, so the courier finds them among Registry plugins", () => {
    expect([...store.runtime.sandboxedPlugins.keys()].sort()).toEqual([`${RECEIVER}:1.0.0`, `${SENDER}:1.0.0`]);
    expect(store.runtime.configuredPlugins.map((plugin) => plugin.id)).toEqual([]);
  });

  test("a Registry plugin's undeclared route is no door, though EmDash answers its lookup", () => {
    expect(store.runtime.getPluginRouteMeta(SENDER, "courier/inbox")).toEqual({ public: false });
    expect(findDoors(store.runtime)).toEqual({ outboxes: [SENDER], inboxes: [RECEIVER], problems: [] });
  });

  const since = { courier: 1, op: "since", topic: "order.shipped", after: null, limit: 50 };
  const forged = { courier: 1, op: "deliver", from: SENDER, topic: "order.shipped", after: null, next: "99", items: [{ id: "forged", at: "2026-11-22T12:00:00Z", data: {} }] };
  const callers = [
    ["someone not signed in", {}, 401, "UNAUTHORIZED"],
    ["the store's administrator", { user: admin }, 400, "COURIER_ONLY"],
    ["the administrator's API token", { user: admin, tokenScopes: ["admin"] }, 400, "COURIER_ONLY"],
  ];
  for (const [who, as, status, code] of callers) {
    test(`${who} can neither read the outbox nor land a delivery`, async () => {
      for (const [plugin, route, body] of [[SENDER, "courier/outbox", since], [RECEIVER, "courier/inbox", forged], [RECEIVER, "courier/inbox", { courier: 1, op: "wants" }]]) {
        const answer = await store.outside(plugin, route, body, as);
        expect(answer.status, `${plugin} ${route}`).toBe(status);
        // A sandboxed refusal crosses as ROUTE_ERROR, its message led by the door's code.
        if (code === "COURIER_ONLY") expect(answer.body.error.message).toContain("COURIER_ONLY: Only the store's courier may use this door.");
        else expect(answer.body.error.code).toBe(code);
      }
      expect(await store.peek(SENDER)).toEqual({ reads: 0 });
      expect(await store.peek(RECEIVER)).toEqual({ got: [], bookmark: null });
    });
  }

  test("store code that passes a person is refused too", async () => {
    const answer = await store.runtime.handlePluginApiRoute(SENDER, "POST", "courier/outbox",
      new Request("https://store.test/", { method: "POST", body: JSON.stringify(since) }), admin);
    expect(answer).toMatchObject({ success: false, error: { code: "ROUTE_ERROR" } });
    expect(answer.error.message).toMatch(/COURIER_ONLY: /);
    expect(await store.peek(SENDER)).toEqual({ reads: 0 });
  });

  test("the courier, with no person, carries every item in the receiver's batches of two", async () => {
    const report = await runCourier(store.runtime);
    expect(report).toMatchObject({ receivers: 1, handoffs: 2, delivered: 3, unfinished: false, problems: [] });
    expect(await store.peek(RECEIVER)).toEqual({ got: ["got:order-1:shipment-1", "got:order-2:shipment-1", "got:order-3:shipment-1"], bookmark: "3" });
    expect((await store.peek(SENDER)).reads).toBe(2);
    // A second run finds nothing new and delivers nothing.
    expect(await runCourier(store.runtime)).toMatchObject({ handoffs: 0, delivered: 0, problems: [] });
  });
});

describe("opaque Registry ids resolved by _plugin_state.registry_slug (issue #3)", () => {
  const OPAQUE_SENDER = "r_gshdrqaldna3r7sn";
  const OPAQUE_SENDER_ALT = "r_bbbbbbbbbbbbbbbb";
  const OPAQUE_RECEIVER = "r_abcdefghijklmnop";
  let opaqueStore;
  let hasRegistrySlugColumn = false;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "courier-registry-opaque-"));
    const url = `file:${join(dir, "store.db")}`;
    const senderCode = await bundle("./registry/sender.js");
    const receiverCode = await bundle("./registry/receiver.js");
    const entry = (id, code, door) => ({
      id, version: "1.0.0", code, capabilities: [], storage: {}, hooks: [],
      routes: [{ name: door, ...DOOR }, { name: "peek", ...DOOR }],
    });
    const runtime = await EmDashRuntime.create({
      config: { database: { entrypoint: `courier-registry-opaque-${crypto.randomUUID()}`, type: "sqlite", config: { url } } },
      plugins: [],
      createDialect: () => createDialect({ url }),
      createStorage: null,
      createScheduler: null,
      sandboxEnabled: true,
      createSandboxRunner: (options) => new WorkerdSandboxRunner(options),
      sandboxedPluginEntries: [
        entry(OPAQUE_SENDER, senderCode, "courier/outbox"),
        entry(OPAQUE_SENDER_ALT, senderCode, "courier/outbox"),
        entry(OPAQUE_RECEIVER, receiverCode, "courier/inbox"),
      ],
    });
    try {
      await runtime.db.selectFrom("_plugin_state").select("registry_slug").limit(1).execute();
      hasRegistrySlugColumn = true;
    } catch {
      hasRegistrySlugColumn = false;
    }
    opaqueStore = {
      runtime,
      async peek(pluginId) {
        const answer = await runtime.handlePluginApiRoute(pluginId, "POST", "peek", new Request("https://store.test/", { method: "POST", body: "{}" }));
        expect(answer.success, JSON.stringify(answer.error)).toBe(true);
        return answer.data;
      },
      async stop() {
        try { await runtime.getSandboxRunner()?.terminateAll(); } catch {}
        try { await runtime.db.destroy(); } catch {}
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }, 60_000);

  afterAll(async () => { await opaqueStore?.stop(); });

  test("resolves opaque sender by active Registry slug, fails closed on collision, and supports options.senders override", async () => {
    // Without _plugin_state slug binding or explicit override, requesting the slug fails closed as SENDER_MISSING.
    expect(findDoors(opaqueStore.runtime)).toEqual({
      outboxes: [OPAQUE_SENDER_ALT, OPAQUE_SENDER].sort(),
      inboxes: [OPAQUE_RECEIVER],
      problems: [],
    });
    const missing = await runCourier(opaqueStore.runtime);
    expect(missing).toMatchObject({ receivers: 1, handoffs: 0, delivered: 0 });
    expect(missing.problems).toEqual([{ plugin: OPAQUE_RECEIVER, code: "SENDER_MISSING", from: SENDER, topic: "order.shipped" }]);

    if (hasRegistrySlugColumn) {
      // EmDash 1.5: mark OPAQUE_SENDER as an active Registry install with its authoritative slug.
      await opaqueStore.runtime.db.updateTable("_plugin_state").set({
        source: "registry",
        status: "active",
        registry_publisher_did: "did:web:dinkuskit.com",
        registry_slug: SENDER,
      }).where("plugin_id", "=", OPAQUE_SENDER).execute();

      const delivered = await runCourier(opaqueStore.runtime);
      expect(delivered).toMatchObject({ receivers: 1, handoffs: 2, delivered: 3, unfinished: false, problems: [] });
      expect(await opaqueStore.peek(OPAQUE_RECEIVER)).toEqual({
        got: ["got:order-1:shipment-1", "got:order-2:shipment-1", "got:order-3:shipment-1"],
        bookmark: "3",
      });
      expect((await opaqueStore.peek(OPAQUE_SENDER)).reads).toBe(2);
      expect((await opaqueStore.peek(OPAQUE_SENDER_ALT)).reads).toBe(0);

      // Repeat tick delivers nothing twice.
      expect(await runCourier(opaqueStore.runtime)).toMatchObject({ receivers: 1, handoffs: 0, delivered: 0, problems: [] });

      // Adding a second active Registry outbox with the same slug fails closed as SENDER_AMBIGUOUS.
      await opaqueStore.runtime.db.updateTable("_plugin_state").set({
        source: "registry",
        status: "active",
        registry_publisher_did: "did:web:other.example",
        registry_slug: SENDER,
      }).where("plugin_id", "=", OPAQUE_SENDER_ALT).execute();
      const ambiguous = await runCourier(opaqueStore.runtime);
      expect(ambiguous.problems).toEqual([{ plugin: OPAQUE_RECEIVER, code: "SENDER_AMBIGUOUS", from: SENDER, topic: "order.shipped" }]);

      // Explicit options.senders disambiguates back to the pinned outbox.
      const pinned = await runCourier(opaqueStore.runtime, { senders: { [SENDER]: OPAQUE_SENDER } });
      expect(pinned).toMatchObject({ receivers: 1, handoffs: 0, delivered: 0, problems: [] });
    } else {
      // EmDash 1.4 has no _plugin_state.registry_slug column; explicit options.senders still resolves opaque ids.
      const pinned = await runCourier(opaqueStore.runtime, { senders: { [SENDER]: OPAQUE_SENDER } });
      expect(pinned).toMatchObject({ receivers: 1, handoffs: 2, delivered: 3, unfinished: false, problems: [] });
      expect(await opaqueStore.peek(OPAQUE_RECEIVER)).toEqual({
        got: ["got:order-1:shipment-1", "got:order-2:shipment-1", "got:order-3:shipment-1"],
        bookmark: "3",
      });
    }
  });
});
