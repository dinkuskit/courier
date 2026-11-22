/**
 * Plugins for the runtime tests. They stand in for real ones: "test-shop" sends
 * "order.shipped" news the way Commerce will, "test-reviews" receives it the way
 * Reviews will. Neither knows the other, and the store names neither.
 */
import { definePlugin } from "emdash";

import { inboxDoor, outboxDoor } from "../src/doors.js";

export const SHOP = "test-shop";
export const REVIEWS = "test-reviews";

/** Sends "order.shipped": one item per shipment, the bookmark is the last shipment's number. */
export const shop = definePlugin({
  id: SHOP,
  version: "1.0.0",
  storage: { shipments: { indexes: ["seq"] } },
  routes: {
    // Test-only: records shipments numbered from `first`.
    ship: {
      handler: async (ctx) => {
        const { first, count } = ctx.input;
        for (let seq = first; seq < first + count; seq += 1) {
          await ctx.storage.shipments.put(`order-${seq}:shipment-1`, {
            seq,
            orderId: `order-${seq}`,
            email: `buyer${seq}@example.test`,
            shippedAt: new Date(Date.UTC(2026, 10, 22, 12, 0, seq % 60)).toISOString(),
          });
        }
        return { shipped: count };
      },
    },
    "courier/outbox": outboxDoor({
      "order.shipped": async ({ after, limit }, ctx) => {
        const from = after === null ? 0 : Number(after);
        const page = await ctx.storage.shipments.query({
          where: { seq: { gt: from } },
          orderBy: { seq: "asc" },
          limit,
        });
        const items = page.items.map(({ id, data }) => ({
          id,
          at: data.shippedAt,
          data: { orderId: data.orderId, email: data.email },
        }));
        const last = page.items.at(-1);
        return { items, next: last ? String(last.data.seq) : after, more: page.hasMore };
      },
    }),
  },
});

/** Hears "order.shipped" from the shop and keeps one invite per item id. */
export const reviews = definePlugin({
  id: REVIEWS,
  version: "1.0.0",
  storage: { invites: { indexes: ["orderId"] } },
  routes: {
    "courier/inbox": inboxDoor({
      wants: [{ from: SHOP, topic: "order.shipped" }],
      deliver: async ({ items }, ctx) => {
        let saved = 0;
        for (const item of items) {
          if (await ctx.storage.invites.exists(item.id)) continue;
          await ctx.storage.invites.put(item.id, { orderId: item.data.orderId, email: item.data.email, shippedAt: item.at });
          saved += 1;
        }
        return saved;
      },
    }),
  },
});

/** A plugin with no courier doors, which the courier leaves alone. */
export const bystander = definePlugin({
  id: "test-bystander",
  version: "1.0.0",
  routes: { ping: { handler: async () => ({ pong: true }) } },
});

/** A plugin that wrongly makes its inbox public: the courier must skip it. */
export const careless = definePlugin({
  id: "test-careless",
  version: "1.0.0",
  routes: { "courier/inbox": { public: true, methods: ["POST"], handler: async () => ({ courier: 1, wants: [] }) } },
});

/** A store administrator, as EmDash hands a signed-in person to a private route. */
export const admin = { id: "admin-1", email: "owner@example.test", name: "Owner", role: 50, createdAt: new Date("2026-11-01T00:00:00.000Z") };
