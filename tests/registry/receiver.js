/**
 * A Registry plugin that receives the sender's topic, for the sandbox proof.
 * It saves each item under its id, so the test can see what landed.
 */
import { inboxDoor } from "../../src/doors.js";

export default {
  hooks: {},
  routes: {
    "courier/inbox": inboxDoor({
      wants: [{ from: "proof-sender", topic: "order.shipped", limit: 2 }],
      deliver: async ({ items }, ctx) => {
        let saved = 0;
        for (const item of items) {
          if (await ctx.kv.get(`got:${item.id}`)) continue;
          await ctx.kv.set(`got:${item.id}`, item.data);
          saved += 1;
        }
        return saved;
      },
    }),
    peek: {
      public: false, permission: "plugins:manage", methods: ["POST"],
      handler: async (_route, ctx) => ({
        got: (await ctx.kv.list("got:")).map((entry) => entry.key).sort(),
        bookmark: (await ctx.kv.get("courier:after:proof-sender:order.shipped")) ?? null,
      }),
    },
  },
};
