/**
 * Courier doors for a plugin: small helpers a plugin bundles to offer
 * `courier/outbox` and `courier/inbox` without writing the guard and the
 * bookmark bookkeeping itself. Works for sandboxed (Registry) plugins, whose
 * route handlers take `(routeCtx, ctx)`, and for trusted plugins, whose
 * handlers take one merged `ctx`.
 *
 * Every door refuses a call that carries a person. EmDash lets a request from
 * outside reach a private route only for a signed-in person with the route's
 * permission, and every API token belongs to a person; the courier calls from
 * the store's own code with no person. So "no person" means "the courier".
 */

export const COURIER_VERSION = 1;
export const OUTBOX_ROUTE = "courier/outbox";
export const INBOX_ROUTE = "courier/inbox";

/** Items in one handoff: 50 unless the receiver asks for another number, and never more than 100. */
const DEFAULT_ITEMS = 50;
const MAX_ITEMS = 100;
const LAST_VISIT_KEY = "courier:last-visit";
const BOOKMARK_PREFIX = "courier:after:";
/** A run is due every minute; five quiet minutes means the courier is late. */
const LATE_AFTER_MS = 5 * 60_000;

/**
 * A refusal whose message starts with its code. EmDash's sandbox passes only
 * the message across, as ROUTE_ERROR, so the courier reads the code from there.
 *
 * EmDash (1.4 and 1.5) knows a PluginRouteError by its shape: an Error named
 * "PluginRouteError" with a string code and a number status. Building one by
 * shape keeps `emdash` out of a Registry bundle, which would otherwise carry
 * about 12 KB of EmDash's own code along with the class.
 */
function refuse(code, words, status) {
  const error = new Error(`${code}: ${words}`);
  error.name = "PluginRouteError";
  return Object.assign(error, { code, status });
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parts(first, second) {
  return second ? { route: first, ctx: second } : { route: first, ctx: first };
}

function onlyTheCourier(route) {
  if (route.user) throw refuse("COURIER_ONLY", "Only the store's courier may use this door.", 403);
  const input = route.input;
  if (!isRecord(input) || input.courier !== COURIER_VERSION || typeof input.op !== "string") {
    throw refuse("BAD_COURIER_REQUEST", "This is not a courier request.", 400);
  }
  return input;
}

function bookmarkKey(from, topic) {
  return `${BOOKMARK_PREFIX}${encodeURIComponent(from)}:${encodeURIComponent(topic)}`;
}

const door = (handler) => ({ public: false, permission: "plugins:manage", methods: ["POST"], handler });

/**
 * The `courier/outbox` route. `topics` maps a topic name to a reader:
 * `({ after, limit }, ctx) => ({ items: [{ id, at, data }], next, more })`.
 * `after` is the receiver's bookmark (null the first time); `next` is the
 * bookmark after the last item given. Items must be safe to give again.
 */
export function outboxDoor(topics) {
  return door(async (first, second) => {
    const { route, ctx } = parts(first, second);
    const input = onlyTheCourier(route);
    if (input.op !== "since" || typeof input.topic !== "string") {
      throw refuse("BAD_COURIER_REQUEST", "An outbox only answers \"since\".", 400);
    }
    const read = Object.hasOwn(topics, input.topic) ? topics[input.topic] : undefined;
    if (typeof read !== "function") throw refuse("UNKNOWN_TOPIC", "This plugin does not send that topic.", 404);
    const after = typeof input.after === "string" ? input.after : null;
    const asked = Number.isInteger(input.limit) ? input.limit : DEFAULT_ITEMS;
    const limit = Math.min(Math.max(asked, 1), MAX_ITEMS);
    const batch = (await read({ after, limit }, ctx)) ?? {};
    // Never cut a reader's answer short: its bookmark would then pass items nobody was given.
    if (!Array.isArray(batch.items) || batch.items.length > limit) {
      throw refuse("BAD_BATCH", `The topic's reader must answer a list of at most ${limit} items.`, 500);
    }
    const next = batch.next === undefined ? after : batch.next;
    return { courier: COURIER_VERSION, items: batch.items, next, more: batch.more === true };
  });
}

/**
 * The `courier/inbox` route.
 *
 * - `wants`: the topics this plugin listens to, as `[{ from, topic }]`, or a
 *   function of `ctx` returning them. The door adds each one's bookmark.
 * - `deliver({ from, topic, items }, ctx)`: saves the items. It must ignore an
 *   item id it already has. The door moves the bookmark only after it returns,
 *   and only forward from the bookmark the batch was asked from.
 */
export function inboxDoor({ wants, deliver }) {
  return door(async (first, second) => {
    const { route, ctx } = parts(first, second);
    const input = onlyTheCourier(route);
    if (input.op === "wants") {
      await ctx.kv.set(LAST_VISIT_KEY, new Date().toISOString());
      const list = typeof wants === "function" ? await wants(ctx) : wants;
      const answer = [];
      for (const want of Array.isArray(list) ? list : []) {
        if (!isRecord(want) || typeof want.from !== "string" || typeof want.topic !== "string") continue;
        const after = await ctx.kv.get(bookmarkKey(want.from, want.topic));
        const limit = Number.isInteger(want.limit) ? Math.min(Math.max(want.limit, 1), MAX_ITEMS) : DEFAULT_ITEMS;
        answer.push({ from: want.from, topic: want.topic, after: typeof after === "string" ? after : null, limit });
      }
      return { courier: COURIER_VERSION, wants: answer };
    }
    if (input.op === "deliver") {
      const { from, topic, items } = input;
      const after = typeof input.after === "string" ? input.after : null;
      const next = typeof input.next === "string" ? input.next : null;
      if (typeof from !== "string" || typeof topic !== "string" || !Array.isArray(items) || items.length > MAX_ITEMS) {
        throw refuse("BAD_COURIER_REQUEST", "A delivery needs from, topic and at most 100 items.", 400);
      }
      const key = bookmarkKey(from, topic);
      const before = await ctx.kv.getVersioned(key);
      const saved = Number(await deliver({ from, topic, items }, ctx)) || 0;
      const current = typeof before?.value === "string" ? before.value : null;
      // A slower, older run never moves the bookmark back: it moves only from the bookmark the batch was asked from.
      let moved = false;
      if (current === after && next !== null && next !== after) {
        moved = (await ctx.kv.compareAndSet(key, before?.revision ?? null, next)).applied;
      }
      return { courier: COURIER_VERSION, saved, moved };
    }
    throw refuse("BAD_COURIER_REQUEST", "An inbox answers \"wants\" and \"deliver\".", 400);
  });
}

/**
 * Whether the courier is visiting this plugin, for its admin page:
 * `{ state: "visiting" | "late" | "missing", lastVisit }`.
 */
export async function courierStatus(ctx, now = Date.now()) {
  const lastVisit = await ctx.kv.get(LAST_VISIT_KEY);
  if (typeof lastVisit !== "string" || Number.isNaN(Date.parse(lastVisit))) return { state: "missing", lastVisit: null };
  return { state: now - Date.parse(lastVisit) > LATE_AFTER_MS ? "late" : "visiting", lastVisit };
}
