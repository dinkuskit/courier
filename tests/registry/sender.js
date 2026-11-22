/**
 * A Registry plugin that sends one topic, for the sandbox proof. Its reader
 * counts every read, so the test can see that a refused call read nothing.
 */
import { outboxDoor } from "../../src/doors.js";

const NEWS = [1, 2, 3].map((n) => ({ id: `order-${n}:shipment-1`, at: `2026-11-22T15:0${n}:00Z`, data: { orderId: `order-${n}` } }));

export default {
  hooks: {},
  routes: {
    "courier/outbox": outboxDoor({
      "order.shipped": async ({ after, limit }, ctx) => {
        await ctx.kv.set("reads", ((await ctx.kv.get("reads")) ?? 0) + 1);
        const start = after === null ? 0 : Number(after);
        const items = NEWS.slice(start, start + limit);
        return { items, next: String(start + items.length), more: start + items.length < NEWS.length };
      },
    }),
    // Lets the test read the counter; not a courier door.
    peek: { public: false, permission: "plugins:manage", methods: ["POST"], handler: async (_route, ctx) => ({ reads: (await ctx.kv.get("reads")) ?? 0 }) },
  },
};
