/**
 * The courier's own rules, against a stand-in runtime: bad answers are never
 * delivered, missing senders are reported, the door helpers work for
 * sandboxed plugins' two-argument handlers, and the store hookups run at most
 * once a minute.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import { installedPluginIds, runCourier } from "../src/index.js";
import { inboxDoor, outboxDoor } from "../src/doors.js";
import { courierOnVisit, courierScheduled, courierTick } from "../src/store.js";

/** A runtime with the given route handlers, keyed "plugin route". */
function fakeRuntime(routes, { sandboxed = [] } = {}) {
  const calls = [];
  return {
    calls,
    configuredPlugins: [...new Set(Object.keys(routes).map((key) => key.split(" ")[0]))]
      .filter((id) => !sandboxed.includes(id)).map((id) => ({ id })),
    sandboxedPlugins: new Map(sandboxed.map((id) => [`${id}:1.0.0`, {}])),
    getPluginRouteMeta(id, route) {
      return routes[`${id} ${route}`] ? { public: false } : null;
    },
    async handlePluginApiRoute(id, method, route, request, user) {
      const body = await request.json();
      calls.push({ id, route, body, user });
      return routes[`${id} ${route}`](body);
    },
  };
}

const wantsShop = { success: true, data: { courier: 1, wants: [{ from: "shop", topic: "order.shipped", after: null }] } };
const item = (id) => ({ id, at: "2026-11-22T12:00:00.000Z", data: { orderId: id } });

describe("finding plugins", () => {
  test("reads trusted plugins and sandboxed plugins' id:version keys", () => {
    const runtime = fakeRuntime({ "a courier/inbox": () => null, "b courier/outbox": () => null }, { sandboxed: ["b"] });
    expect(installedPluginIds(runtime)).toEqual(["a", "b"]);
  });
});

describe("what the courier refuses to carry", () => {
  test("calls every door with no person attached", async () => {
    const runtime = fakeRuntime({
      "reviews courier/inbox": () => wantsShop,
      "shop courier/outbox": () => ({ success: true, data: { courier: 1, items: [], next: null, more: false } }),
    });
    await runCourier(runtime);
    expect(runtime.calls.length).toBeGreaterThan(0);
    expect(runtime.calls.every((call) => call.user === undefined)).toBe(true);
  });

  test("asks the sender for the receiver's number, 50 when it names none, never more than 100", async () => {
    const asked = [];
    for (const limit of [undefined, 100, 500]) {
      const runtime = fakeRuntime({
        "reviews courier/inbox": () => ({ success: true, data: { courier: 1, wants: [{ from: "shop", topic: "order.shipped", after: null, limit }] } }),
        "shop courier/outbox": (body) => {
          asked.push(body.limit);
          return { success: true, data: { courier: 1, items: Array.from({ length: body.limit }, (_, n) => item(`x${n}`)), next: "1", more: false } };
        },
      });
      const report = await runCourier(runtime);
      expect(report.problems).toEqual([]);
      expect(report.delivered).toBe(asked.at(-1));
    }
    expect(asked).toEqual([50, 100, 100]);
  });

  test("reads the door's code from a sandboxed plugin's refusal, which EmDash passes on only as ROUTE_ERROR", async () => {
    const runtime = fakeRuntime({
      "reviews courier/inbox": () => wantsShop,
      "shop courier/outbox": () => ({ success: false, error: { code: "ROUTE_ERROR", message: "PluginRouteError: UNKNOWN_TOPIC: This plugin does not send that topic." } }),
    });
    const report = await runCourier(runtime);
    expect(report.problems).toEqual([{ plugin: "shop", code: "UNKNOWN_TOPIC", route: "courier/outbox", topic: "order.shipped" }]);
  });

  test("reads COURIER_ONLY from the exact message EmDash 1.5's sandbox returns", async () => {
    const runtime = fakeRuntime({
      "reviews courier/inbox": () => wantsShop,
      "shop courier/outbox": () => ({ success: false, error: { code: "ROUTE_ERROR", message: "PluginRouteError: COURIER_ONLY: Only the store's courier may use this door." } }),
    });
    expect((await runCourier(runtime)).problems[0].code).toBe("COURIER_ONLY");
  });

  test("a sandboxed error with no code in its message stays ROUTE_ERROR", async () => {
    const runtime = fakeRuntime({
      "reviews courier/inbox": () => wantsShop,
      "shop courier/outbox": () => ({ success: false, error: { code: "ROUTE_ERROR", message: "Error: something broke" } }),
    });
    expect((await runCourier(runtime)).problems[0].code).toBe("ROUTE_ERROR");
  });

  test("a receiver asking for a sender that is not installed is reported", async () => {
    const runtime = fakeRuntime({ "reviews courier/inbox": () => wantsShop });
    const report = await runCourier(runtime);
    expect(report.problems).toEqual([{ plugin: "reviews", code: "SENDER_MISSING", from: "shop", topic: "order.shipped" }]);
  });

  for (const [name, batch] of [
    ["an item over 8 KB", { items: [{ ...item("x"), data: { note: "a".repeat(9000) } }], next: "1", more: false }],
    ["two items with one id", { items: [item("x"), item("x")], next: "1", more: false }],
    ["an item without an id", { items: [{ at: "2026-11-22T12:00:00.000Z", data: {} }], next: "1", more: false }],
    ["an item with a bad time", { items: [{ id: "x", at: "soon", data: {} }], next: "1", more: false }],
    ["more items than were asked for", { items: Array.from({ length: 51 }, (_, n) => item(`x${n}`)), next: "1", more: false }],
  ]) {
    test(`a batch with ${name} is not delivered`, async () => {
      let delivered = false;
      const runtime = fakeRuntime({
        "reviews courier/inbox": (body) => {
          if (body.op === "deliver") delivered = true;
          return wantsShop;
        },
        "shop courier/outbox": () => ({ success: true, data: { courier: 1, ...batch } }),
      });
      const report = await runCourier(runtime);
      expect(delivered).toBe(false);
      expect(report.problems).toEqual([{ plugin: "shop", code: "BAD_BATCH", route: "courier/outbox", topic: "order.shipped" }]);
    });
  }

  test("an answer that is not a courier answer is reported, not delivered", async () => {
    const runtime = fakeRuntime({ "reviews courier/inbox": () => ({ success: true, data: { hello: true } }) });
    const report = await runCourier(runtime);
    expect(report.problems).toEqual([{ plugin: "reviews", code: "NOT_A_COURIER_ANSWER", route: "courier/inbox" }]);
  });

  test("a sender that says 'more' without moving its bookmark does not loop", async () => {
    let asked = 0;
    const runtime = fakeRuntime({
      "reviews courier/inbox": (body) => (body.op === "wants" ? wantsShop : { success: true, data: { courier: 1, saved: 1 } }),
      "shop courier/outbox": () => {
        asked += 1;
        return { success: true, data: { courier: 1, items: [item(`x${asked}`)], next: "same", more: true } };
      },
    });
    await runCourier(runtime);
    expect(asked).toBe(2);
  });
});

describe("door helpers in a sandboxed plugin", () => {
  const kv = () => {
    const values = new Map();
    return {
      get: async (key) => values.get(key)?.value ?? null,
      set: async (key, value) => values.set(key, { value, revision: String(Math.random()) }),
      getVersioned: async (key) => values.get(key) ?? null,
      compareAndSet: async (key, revision, value) => {
        if ((values.get(key)?.revision ?? null) !== revision) return { applied: false };
        values.set(key, { value, revision: String(Math.random()) });
        return { applied: true };
      },
    };
  };

  test("refuses a call that carries a person, before reading anything", async () => {
    const read = vi.fn();
    const door = outboxDoor({ "order.shipped": read });
    await expect(door.handler({ input: { courier: 1, op: "since", topic: "order.shipped" }, user: { id: "u", role: 50 } }, { kv: kv() }))
      .rejects.toMatchObject({ code: "COURIER_ONLY", status: 403, message: expect.stringMatching(/^COURIER_ONLY: /) });
    expect(read).not.toHaveBeenCalled();
  });

  test("answers the courier with the plugin's batch", async () => {
    const door = outboxDoor({ "order.shipped": async ({ after, limit }) => ({ items: [item("x")], next: `${after}+${limit}`, more: false }) });
    const answer = await door.handler({ input: { courier: 1, op: "since", topic: "order.shipped", after: "5", limit: 80 } }, { kv: kv() });
    expect(answer).toEqual({ courier: 1, items: [item("x")], next: "5+80", more: false });
  });

  test("a sender reads 50 unless asked for more, and never more than 100", async () => {
    const door = outboxDoor({ "order.shipped": async ({ limit }) => ({ items: [], next: String(limit), more: false }) });
    const ask = async (extra) => (await door.handler({ input: { courier: 1, op: "since", topic: "order.shipped", ...extra } }, { kv: kv() })).next;
    expect(await ask({})).toBe("50");
    expect(await ask({ limit: 500 })).toBe("100");
    expect(await ask({ limit: 0 })).toBe("1");
  });

  test("an unknown topic is refused", async () => {
    const door = outboxDoor({});
    await expect(door.handler({ input: { courier: 1, op: "since", topic: "toString" } }, { kv: kv() }))
      .rejects.toMatchObject({ code: "UNKNOWN_TOPIC" });
  });

  test("the inbox keeps the bookmark and moves it only forward", async () => {
    const store = kv();
    const deliver = vi.fn(async ({ items }) => items.length);
    const door = inboxDoor({ wants: [{ from: "shop", topic: "order.shipped" }], deliver });
    const call = (input) => door.handler({ input: { courier: 1, ...input } }, { kv: store });
    expect(await call({ op: "wants" })).toEqual({ courier: 1, wants: [{ from: "shop", topic: "order.shipped", after: null, limit: 50 }] });
    expect(await call({ op: "deliver", from: "shop", topic: "order.shipped", items: [item("a")], after: null, next: "1" }))
      .toEqual({ courier: 1, saved: 1, moved: true });
    // An older run, asked from the empty bookmark, arrives late: its items are offered again, the bookmark stays.
    expect(await call({ op: "deliver", from: "shop", topic: "order.shipped", items: [item("a")], after: null, next: "1" }))
      .toEqual({ courier: 1, saved: 1, moved: false });
    expect((await call({ op: "wants" })).wants[0].after).toBe("1");
  });
});

describe("running in a store", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("a run already going is shared, not doubled", async () => {
    let started = 0;
    let finish;
    const withEmDashRuntime = (run) => {
      started += 1;
      return new Promise((resolve) => { finish = () => resolve(run(fakeRuntime({}))); });
    };
    const one = courierTick({ withEmDashRuntime });
    const two = courierTick({ withEmDashRuntime });
    expect(one).toBe(two);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    finish();
    expect(await one).toMatchObject({ receivers: 0, handoffs: 0 });
    expect(started).toBe(1);
  });

  test("a failed run is logged and never rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const report = await courierTick({ withEmDashRuntime: async () => { throw new Error("no database"); } });
    expect(report).toBeNull();
    expect(warn).toHaveBeenCalledWith("[courier] the run failed:", "no database");
    warn.mockRestore();
  });

  test("the Cloudflare timer hands the run to waitUntil", async () => {
    const waitUntil = vi.fn();
    const run = courierScheduled({ withEmDashRuntime: async (fn) => fn(fakeRuntime({})) })({}, {}, { waitUntil });
    expect(waitUntil).toHaveBeenCalledWith(run);
    await run;
  });

  test("on Node, visits start a run at most once a minute, after the page", async () => {
    const after = vi.fn();
    const next = vi.fn(async () => "page");
    const visit = courierOnVisit({ everyMs: 60_000, after, withEmDashRuntime: async (fn) => fn(fakeRuntime({})) });
    vi.spyOn(Date, "now").mockReturnValue(1_000_000_000_000);
    expect(await visit({}, next)).toBe("page");
    expect(await visit({}, next)).toBe("page");
    expect(after).toHaveBeenCalledTimes(1);
    Date.now.mockReturnValue(1_000_000_000_000 + 60_000);
    await visit({}, next);
    expect(after).toHaveBeenCalledTimes(2);
    Date.now.mockRestore();
  });

  test("on Cloudflare, visits leave the courier to the timer", async () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    const after = vi.fn();
    const visit = courierOnVisit({ everyMs: 1, after });
    await visit({}, async () => "page");
    expect(after).not.toHaveBeenCalled();
  });
});
