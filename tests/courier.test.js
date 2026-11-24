/**
 * The courier's own rules, against a stand-in runtime: bad answers are never
 * delivered, missing senders are reported, the door helpers work for
 * sandboxed plugins' two-argument handlers, and the Cloudflare timer hands
 * each run to the Worker.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import { installedPluginIds, runCourier } from "../src/index.js";
import { inboxDoor, outboxDoor } from "../src/doors.js";
import { courierScheduled, courierTick } from "../src/store.js";

/** A runtime with the given route handlers, keyed "plugin route". */
function fakeRuntime(routes, { sandboxed = [], registryStates = null } = {}) {
  const calls = [];
  const runtime = {
    calls,
    configuredPlugins: [...new Set(Object.keys(routes).map((key) => key.split(" ")[0]))]
      .filter((id) => !sandboxed.includes(id)).map((id) => ({ id })),
    sandboxedPlugins: new Map(sandboxed.map((id) => [`${id}:1.0.0`, {}])),
    getPluginRouteMeta(id, route) {
      return routes[`${id} ${route}`] ? { public: false, methods: ["POST"] } : { public: false };
    },
    async handlePluginApiRoute(id, method, route, request, user) {
      const body = await request.json();
      calls.push({ id, route, body, user });
      return routes[`${id} ${route}`](body);
    },
  };
  if (registryStates !== null) {
    runtime.db = {
      selectFrom(table) {
        if (table !== "_plugin_state") throw new Error(`unexpected table ${table}`);
        const filters = [];
        const query = {
          select() { return query; },
          where(col, op, val) { filters.push([col, op, val]); return query; },
          async execute() {
            if (typeof registryStates === "function") return registryStates();
            return registryStates.filter((row) => filters.every(([col, , val]) => row[col] === val));
          },
        };
        return query;
      },
    };
  }
  return runtime;
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
    // The exact message EmDash 1.5's sandbox returns: the error's name, then the door's code.
    for (const code of ["UNKNOWN_TOPIC", "COURIER_ONLY"]) {
      const runtime = fakeRuntime({
        "reviews courier/inbox": () => wantsShop,
        "shop courier/outbox": () => ({ success: false, error: { code: "ROUTE_ERROR", message: `PluginRouteError: ${code}: The door said no.` } }),
      });
      expect((await runCourier(runtime)).problems).toEqual([{ plugin: "shop", code, route: "courier/outbox", topic: "order.shipped" }]);
    }
  });

  test("a sandboxed error with no code in its message stays ROUTE_ERROR", async () => {
    const runtime = fakeRuntime({
      "reviews courier/inbox": () => wantsShop,
      "shop courier/outbox": () => ({ success: false, error: { code: "ROUTE_ERROR", message: "Error: something broke" } }),
    });
    expect((await runCourier(runtime)).problems[0].code).toBe("ROUTE_ERROR");
  });

  test("receivers with nothing new spend none of the run's handoffs, so a later receiver still gets its news", async () => {
    const idle = Array.from({ length: 20 }, (_, n) => ({ from: "shop", topic: `quiet.${n}`, after: "0" }));
    const runtime = fakeRuntime({
      "a-first courier/inbox": (body) => (body.op === "wants" ? { success: true, data: { courier: 1, wants: idle } } : { success: true, data: { courier: 1, saved: 0, moved: true } }),
      "b-later courier/inbox": (body) => (body.op === "wants" ? wantsShop : { success: true, data: { courier: 1, saved: body.items.length, moved: true } }),
      "shop courier/outbox": (body) => ({ success: true, data: body.topic === "order.shipped"
        ? { courier: 1, items: [item("x")], next: "1", more: false } : { courier: 1, items: [], next: body.after, more: false } }),
    });
    const report = await runCourier(runtime);
    expect(report).toMatchObject({ receivers: 2, handoffs: 1, delivered: 1, unfinished: false });
    expect(runtime.calls.filter((call) => call.body.op === "deliver").map((call) => call.id)).toEqual(["b-later"]);
  });

  test("a store may lower the limits, never raise them", async () => {
    const big = { ...item("x"), data: { note: "a".repeat(9000) } };
    const runtime = fakeRuntime({
      "reviews courier/inbox": (body) => (body.op === "wants" ? wantsShop : { success: true, data: { courier: 1, saved: body.items.length, moved: true } }),
      "shop courier/outbox": () => ({ success: true, data: { courier: 1, items: [big], next: "1", more: false } }),
    });
    expect((await runCourier(runtime, { limits: { itemBytes: 16384, handoffsPerRun: 21 } })).problems[0].code).toBe("BAD_BATCH");
    const many = fakeRuntime({
      "reviews courier/inbox": (body) => (body.op === "wants" ? wantsShop : { success: true, data: { courier: 1, saved: body.items.length, moved: true } }),
      "shop courier/outbox": (body) => ({ success: true, data: { courier: 1, items: [item(`i${body.after}`)], next: String(Number(body.after ?? 0) + 1), more: true } }),
    });
    expect(await runCourier(many, { limits: { handoffsPerRun: 500 } })).toMatchObject({ handoffs: 20, unfinished: true });
    expect(await runCourier(many, { limits: { handoffsPerRun: 3 } })).toMatchObject({ handoffs: 3, unfinished: true });
  });

  test("a receiver asking for a sender that is not installed is reported", async () => {
    const runtime = fakeRuntime({ "reviews courier/inbox": () => wantsShop });
    const report = await runCourier(runtime);
    expect(report.problems).toEqual([{ plugin: "reviews", code: "SENDER_MISSING", from: "shop", topic: "order.shipped" }]);
  });

  test("resolves an opaque Registry outbox by its active _plugin_state.registry_slug and preserves want.from on deliver", async () => {
    const opaqueShop = "r_gshdrqaldna3r7sn";
    const opaqueReviews = "r_abcdefghijklmnop";
    const runtime = fakeRuntime({
      [`${opaqueReviews} courier/inbox`]: (body) => (body.op === "wants" ? wantsShop : { success: true, data: { courier: 1, saved: body.items.length, moved: true } }),
      [`${opaqueShop} courier/outbox`]: () => ({ success: true, data: { courier: 1, items: [item("ord-1")], next: "1", more: false } }),
    }, {
      sandboxed: [opaqueShop, opaqueReviews],
      registryStates: [
        { plugin_id: opaqueShop, source: "registry", status: "active", registry_slug: "shop" },
        { plugin_id: "r_inactive00000000", source: "registry", status: "inactive", registry_slug: "shop" },
        { plugin_id: "r_other00000000000", source: "marketplace", status: "active", registry_slug: "shop" },
      ],
    });
    const report = await runCourier(runtime);
    expect(report).toMatchObject({ receivers: 1, handoffs: 1, delivered: 1, problems: [] });
    expect(runtime.calls.find((c) => c.route === "courier/outbox")?.id).toBe(opaqueShop);
    expect(runtime.calls.find((c) => c.body.op === "deliver")?.body.from).toBe("shop");
  });

  test("fails closed as SENDER_AMBIGUOUS when two active outboxes match one slug, and options.senders disambiguates", async () => {
    const first = "r_gshdrqaldna3r7sn";
    const second = "r_bbbbbbbbbbbbbbbb";
    const runtime = fakeRuntime({
      "r_reviews000000000 courier/inbox": (body) => (body.op === "wants" ? wantsShop : { success: true, data: { courier: 1, saved: body.items.length, moved: true } }),
      [`${first} courier/outbox`]: () => ({ success: true, data: { courier: 1, items: [item("from-first")], next: "1", more: false } }),
      [`${second} courier/outbox`]: () => ({ success: true, data: { courier: 1, items: [item("from-second")], next: "1", more: false } }),
    }, {
      sandboxed: [first, second, "r_reviews000000000"],
      registryStates: [
        { plugin_id: first, source: "registry", status: "active", registry_slug: "shop" },
        { plugin_id: second, source: "registry", status: "active", registry_slug: "shop" },
      ],
    });
    const ambiguous = await runCourier(runtime);
    expect(ambiguous).toMatchObject({ handoffs: 0, delivered: 0 });
    expect(ambiguous.problems).toEqual([{ plugin: "r_reviews000000000", code: "SENDER_AMBIGUOUS", from: "shop", topic: "order.shipped" }]);

    const pinned = await runCourier(runtime, { senders: { shop: second } });
    expect(pinned).toMatchObject({ receivers: 1, handoffs: 1, delivered: 1, problems: [] });
    expect(runtime.calls.find((c) => c.route === "courier/outbox")?.id).toBe(second);
    expect(runtime.calls.find((c) => c.body.op === "deliver")?.body.items[0].id).toBe("from-second");
  });

  test("fails closed as SENDER_AMBIGUOUS when a configured outbox and a Registry outbox share the same name", async () => {
    const opaqueShop = "r_gshdrqaldna3r7sn";
    const runtime = fakeRuntime({
      "reviews courier/inbox": () => wantsShop,
      "shop courier/outbox": () => ({ success: true, data: { courier: 1, items: [item("a")], next: "1", more: false } }),
      [`${opaqueShop} courier/outbox`]: () => ({ success: true, data: { courier: 1, items: [item("b")], next: "1", more: false } }),
    }, {
      sandboxed: [opaqueShop],
      registryStates: [{ plugin_id: opaqueShop, source: "registry", status: "active", registry_slug: "shop" }],
    });
    const report = await runCourier(runtime);
    expect(report.problems).toEqual([{ plugin: "reviews", code: "SENDER_AMBIGUOUS", from: "shop", topic: "order.shipped" }]);
  });

  test("options.senders fails closed when the pinned id has no installed outbox, and ignores inherited prototype keys", async () => {
    const runtime = fakeRuntime({
      "reviews courier/inbox": () => ({ success: true, data: { courier: 1, wants: [{ from: "shop", topic: "order.shipped", after: null }, { from: "toString", topic: "t", after: null }] } }),
      "shop courier/outbox": () => ({ success: true, data: { courier: 1, items: [item("a")], next: "1", more: false } }),
    });
    const report = await runCourier(runtime, { senders: { shop: "r_missing000000000" } });
    expect(report.handoffs).toBe(0);
    expect(report.problems).toEqual([
      { plugin: "reviews", code: "SENDER_MISSING", from: "shop", topic: "order.shipped" },
      { plugin: "reviews", code: "SENDER_MISSING", from: "toString", topic: "t" },
    ]);
  });

  test("falls back to direct plugin ids when _plugin_state.registry_slug is unavailable (EmDash 1.4)", async () => {
    const runtime = fakeRuntime({
      "reviews courier/inbox": (body) => (body.op === "wants" ? wantsShop : { success: true, data: { courier: 1, saved: body.items.length, moved: true } }),
      "shop courier/outbox": () => ({ success: true, data: { courier: 1, items: [item("x")], next: "1", more: false } }),
    }, {
      registryStates: () => { throw new Error("no such column: registry_slug"); },
    });
    const report = await runCourier(runtime);
    expect(report).toMatchObject({ receivers: 1, handoffs: 1, delivered: 1, problems: [] });
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

  test("a reader's answer is never cut short: too many items, or no list, is refused and moves nothing", async () => {
    for (const answer of [{ items: Array.from({ length: 51 }, (_, n) => item(`i${n}`)), next: "51" }, { items: "none", next: "9" }]) {
      const door = outboxDoor({ "order.shipped": async () => answer });
      await expect(door.handler({ input: { courier: 1, op: "since", topic: "order.shipped", after: "0", limit: 50 } }, { kv: kv() }))
        .rejects.toMatchObject({ code: "BAD_BATCH", status: 500, message: expect.stringMatching(/^BAD_BATCH: /) });
    }
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
});
