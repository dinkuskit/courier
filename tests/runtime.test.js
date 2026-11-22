/**
 * The courier against a real EmDash runtime (Node's built-in SQLite), with the
 * plugins in ./fixtures.js. "Outside" requests go through EmDash's production
 * plugin-route policy boundary, the same code the site's HTTP route runs.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { findDoors, runCourier } from "../src/index.js";
import { courierStatus } from "../src/doors.js";
import { admin, bystander, careless, REVIEWS, reviews, SHOP, shop } from "./fixtures.js";
import { startStore } from "./harness.js";

let store;

async function ship(first, count) {
  const result = await store.runtime.handlePluginApiRoute(SHOP, "POST", "ship",
    new Request("http://store.test/", { method: "POST", body: JSON.stringify({ first, count }), headers: { "Content-Type": "application/json" } }));
  expect(result.success).toBe(true);
}

async function invites() {
  const rows = await store.runtime.db.selectFrom("_plugin_storage").select(["id"])
    .where("plugin_id", "=", REVIEWS).where("collection", "=", "invites").execute();
  return rows.map((row) => row.id).sort();
}

/** The reviews plugin's own view of the courier, read the way its admin page would. */
async function reviewsKv(key) {
  const row = await store.runtime.db.selectFrom("options").select(["value"])
    .where("name", "=", `plugin:${REVIEWS}:${key}`).executeTakeFirst();
  return row ? JSON.parse(row.value) : null;
}

beforeEach(async () => {
  store = await startStore([shop, reviews, bystander, careless]);
});

afterEach(async () => {
  await store.stop();
});

describe("finding the doors", () => {
  test("finds every installed plugin's doors without the store naming any plugin", () => {
    const { outboxes, inboxes, problems } = findDoors(store.runtime);
    expect(outboxes).toEqual([SHOP]);
    expect(inboxes).toEqual([REVIEWS]);
    expect(problems).toEqual([{ plugin: "test-careless", code: "PUBLIC_DOOR", route: "courier/inbox" }]);
  });
});

describe("delivering with nobody signed in", () => {
  test("hands shipped orders to the receiver and moves its bookmark", async () => {
    await ship(1, 3);
    const report = await runCourier(store.runtime);
    expect(report).toMatchObject({ receivers: 1, handoffs: 1, delivered: 3, unfinished: false });
    expect(await invites()).toEqual(["order-1:shipment-1", "order-2:shipment-1", "order-3:shipment-1"]);
    expect(await reviewsKv(`courier:after:${SHOP}:order.shipped`)).toBe("3");
  });

  test("a second run with nothing new hands nothing over", async () => {
    await ship(1, 2);
    await runCourier(store.runtime);
    const again = await runCourier(store.runtime);
    expect(again).toMatchObject({ receivers: 1, handoffs: 0, delivered: 0 });
    expect(await invites()).toHaveLength(2);
  });

  test("only news since the bookmark is carried", async () => {
    await ship(1, 2);
    await runCourier(store.runtime);
    await ship(3, 2);
    const report = await runCourier(store.runtime);
    expect(report.delivered).toBe(2);
    expect(await invites()).toHaveLength(4);
    expect(await reviewsKv(`courier:after:${SHOP}:order.shipped`)).toBe("4");
  });

  test("a backlog moves 50 at a time and stops at the run's limit; the next run carries the rest", async () => {
    await ship(1, 120);
    const first = await runCourier(store.runtime, { limits: { handoffsPerRun: 2 } });
    expect(first).toMatchObject({ handoffs: 2, delivered: 100, unfinished: true });
    const second = await runCourier(store.runtime, { limits: { handoffsPerRun: 2 } });
    expect(second).toMatchObject({ handoffs: 1, delivered: 20, unfinished: false });
    expect(await invites()).toHaveLength(120);
  });

  test("the same batch delivered twice changes nothing", async () => {
    await ship(1, 2);
    await runCourier(store.runtime);
    // A slower, older run delivers the first batch again from the empty bookmark.
    const repeat = await store.runtime.handlePluginApiRoute(REVIEWS, "POST", "courier/inbox",
      new Request("http://store.test/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courier: 1, op: "deliver", from: SHOP, topic: "order.shipped", after: null, next: "1",
          items: [{ id: "order-1:shipment-1", at: "2026-11-22T12:00:01.000Z", data: { orderId: "order-1" } }],
        }),
      }));
    expect(repeat).toMatchObject({ success: true, data: { courier: 1, saved: 0, moved: false } });
    expect(await invites()).toHaveLength(2);
    expect(await reviewsKv(`courier:after:${SHOP}:order.shipped`)).toBe("2");
  });

  test("the receiver can tell when the courier last came", async () => {
    const ctx = { kv: { get: (key) => reviewsKv(key) } };
    expect((await courierStatus(ctx)).state).toBe("missing");
    await runCourier(store.runtime);
    const status = await courierStatus(ctx);
    expect(status.state).toBe("visiting");
    expect((await courierStatus(ctx, Date.parse(status.lastVisit) + 6 * 60_000)).state).toBe("late");
  });
});

describe("only the store can use the doors", () => {
  for (const [plugin, route] of [[SHOP, "courier/outbox"], [REVIEWS, "courier/inbox"]]) {
    test(`${plugin} ${route}: a request from someone not signed in is refused before it reaches the plugin`, async () => {
      const answer = await store.outside(plugin, route, { courier: 1, op: "wants" });
      expect(answer.status).toBe(401);
      expect(answer.body.error.code).toBe("UNAUTHORIZED");
    });

    test(`${plugin} ${route}: even the store's administrator is refused`, async () => {
      const answer = await store.outside(plugin, route, { courier: 1, op: route.endsWith("outbox") ? "since" : "wants", topic: "order.shipped" }, admin);
      expect(answer.status).toBe(403);
      expect(answer.body.error.code).toBe("COURIER_ONLY");
    });
  }

  test("an outside delivery never lands", async () => {
    await store.outside(REVIEWS, "courier/inbox", {
      courier: 1, op: "deliver", from: SHOP, topic: "order.shipped", after: null, next: "99",
      items: [{ id: "forged", at: "2026-11-22T12:00:00.000Z", data: {} }],
    }, admin);
    expect(await invites()).toEqual([]);
    expect(await reviewsKv(`courier:after:${SHOP}:order.shipped`)).toBeNull();
  });
});
