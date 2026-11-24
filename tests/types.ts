// Compile-time checks that the declared types fit how a plugin and a store use them.
import { inboxDoor, outboxDoor, courierStatus } from "@dinkuskit/courier/doors";
import { courierScheduled } from "@dinkuskit/courier/store";
import { runCourier, type CourierReport } from "@dinkuskit/courier";

const outbox = outboxDoor({
  "order.shipped": async ({ after, limit }) => ({ items: [], next: after, more: limit < 0 }),
});
const inbox = inboxDoor({
  wants: [{ from: "dinkus-commerce", topic: "order.shipped" }],
  deliver: async ({ items }) => items.length,
});
export const routes = { "courier/outbox": outbox, "courier/inbox": inbox };
export const scheduled = courierScheduled();
export const pinnedScheduled = courierScheduled({ senders: { "dinkus-commerce": "r_gshdrqaldna3r7sn" } });
export async function status(kv: Parameters<typeof courierStatus>[0]["kv"]): Promise<string> {
  return (await courierStatus({ kv })).state;
}
export async function run(runtime: Parameters<typeof runCourier>[0]): Promise<CourierReport> {
  return runCourier(runtime, { senders: { "dinkus-commerce": "r_gshdrqaldna3r7sn" } });
}
