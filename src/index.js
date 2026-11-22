/**
 * The DinkusKit courier: carries news between the plugins installed in one
 * EmDash store.
 *
 * EmDash runs each plugin in its own sandbox, and one plugin cannot call
 * another. The store's own server code can reach every plugin from the inside,
 * so the courier runs there. Each plugin that takes part offers two private
 * doors:
 *
 * - `courier/outbox` answers "what happened since this bookmark?" for a topic;
 * - `courier/inbox` says what it wants and from which bookmark, and takes a
 *   batch of news together with the new bookmark.
 *
 * The courier keeps nothing: every bookmark stays with the plugin that receives
 * the news, and every item carries an id, so a repeated delivery changes
 * nothing. One run is safe to repeat at any time.
 *
 * The courier calls the doors with no person attached. Over HTTP, EmDash only
 * lets a signed-in person with the route's permission reach a private route,
 * and every API token belongs to a person, so a door refuses any call that
 * carries a person (see `./doors.js`).
 */

export const COURIER_VERSION = 1;
export const OUTBOX_ROUTE = "courier/outbox";
export const INBOX_ROUTE = "courier/inbox";

/** The default limits of one run. */
export const DEFAULT_LIMITS = Object.freeze({
  /** Items in one handoff when the receiver asks for no other number. */
  itemsPerHandoff: 50,
  /** The most items a receiver may ask for in one handoff. */
  maxItemsPerHandoff: 100,
  /** Handoffs (batches with news given to a receiver) in one run, across every receiver. An empty answer is no handoff. */
  handoffsPerRun: 20,
  /** Topics one receiver may ask for. */
  wantsPerReceiver: 20,
  /** Characters in an item id. */
  idLength: 200,
  /** Characters in a topic name or a plugin id. */
  nameLength: 100,
  /** Characters in a bookmark. */
  bookmarkLength: 500,
  /** Bytes of one item's JSON. */
  itemBytes: 8192,
});

const ORIGIN = "http://courier.internal";
const encoder = new TextEncoder();

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isName(value, limits) {
  return typeof value === "string" && value.length > 0 && value.length <= limits.nameLength;
}

function isBookmark(value, limits) {
  return value === null || (typeof value === "string" && value.length <= limits.bookmarkLength);
}

/**
 * Every plugin id the runtime has loaded: trusted plugins from the site's
 * config and sandboxed plugins (Registry or marketplace), whose runtime keys
 * are `id:version`.
 */
export function installedPluginIds(runtime) {
  const ids = new Set();
  for (const plugin of runtime.configuredPlugins ?? []) {
    if (typeof plugin?.id === "string") ids.add(plugin.id);
  }
  for (const entry of runtime.sandboxedPluginEntries ?? []) {
    if (typeof entry?.id === "string") ids.add(entry.id);
  }
  const sandboxed = runtime.sandboxedPlugins;
  if (sandboxed && typeof sandboxed.keys === "function") {
    for (const key of sandboxed.keys()) {
      if (typeof key !== "string") continue;
      const at = key.lastIndexOf(":");
      if (at > 0) ids.add(key.slice(0, at));
    }
  }
  return [...ids].sort();
}

/**
 * The plugins offering each door. A door must be private: a public courier door
 * would let anyone on the internet post news, so the courier skips it and
 * reports it.
 *
 * A door is a route the plugin declares as `POST`. EmDash answers a route
 * lookup for a Registry plugin with `{ public: false }` even for a route the
 * plugin never declared, so an answer that names no methods is no door.
 */
export function findDoors(runtime, ids = installedPluginIds(runtime)) {
  const outboxes = [];
  const inboxes = [];
  const problems = [];
  for (const id of ids) {
    for (const [route, list] of [[OUTBOX_ROUTE, outboxes], [INBOX_ROUTE, inboxes]]) {
      let meta = null;
      try {
        meta = runtime.getPluginRouteMeta(id, route);
      } catch {
        meta = null;
      }
      if (!meta || !Array.isArray(meta.methods) || !meta.methods.includes("POST")) continue;
      if (meta.public === true) {
        problems.push({ plugin: id, code: "PUBLIC_DOOR", route });
        continue;
      }
      list.push(id);
    }
  }
  return { outboxes, inboxes, problems };
}

/** Calls one door as the store, with no person attached. */
async function knock(runtime, pluginId, route, body) {
  const request = new Request(`${ORIGIN}/_emdash/api/plugins/${encodeURIComponent(pluginId)}/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let result;
  try {
    result = await runtime.handlePluginApiRoute(pluginId, "POST", route, request);
  } catch {
    return { ok: false, code: "DOOR_FAILED" };
  }
  if (!result?.success) {
    let code = typeof result?.error?.code === "string" ? result.error.code : "DOOR_FAILED";
    // A sandboxed plugin's refusal arrives as ROUTE_ERROR; its message starts with the door's own code.
    if (code === "ROUTE_ERROR") code = /\b([A-Z][A-Z0-9_]{2,}): /.exec(String(result.error.message ?? ""))?.[1] ?? code;
    return { ok: false, code };
  }
  const data = result.data;
  if (!isRecord(data) || data.courier !== COURIER_VERSION) return { ok: false, code: "NOT_A_COURIER_ANSWER" };
  return { ok: true, data };
}

/** A receiver's list of wanted topics, keeping only well-formed entries. */
function readWants(data, limits) {
  if (!Array.isArray(data.wants)) return null;
  const wants = [];
  const seen = new Set();
  for (const want of data.wants.slice(0, limits.wantsPerReceiver)) {
    if (!isRecord(want) || !isName(want.from, limits) || !isName(want.topic, limits)) continue;
    const after = want.after === undefined ? null : want.after;
    if (!isBookmark(after, limits)) continue;
    const asked = Number.isInteger(want.limit) ? want.limit : limits.itemsPerHandoff;
    const limit = Math.min(Math.max(asked, 1), limits.maxItemsPerHandoff);
    const key = `${want.from}\u0000${want.topic}`;
    if (seen.has(key)) continue;
    seen.add(key);
    wants.push({ from: want.from, topic: want.topic, after, limit });
  }
  return wants;
}

/**
 * A sender's batch, or null when any part of it is out of shape. A bad batch is
 * never delivered, so the receiver's bookmark stays where it was.
 */
function readBatch(data, limits, limit) {
  if (!Array.isArray(data.items) || data.items.length > limit) return null;
  if (!isBookmark(data.next ?? null, limits) || typeof (data.more ?? false) !== "boolean") return null;
  const items = [];
  const ids = new Set();
  for (const item of data.items) {
    if (!isRecord(item)) return null;
    if (typeof item.id !== "string" || item.id.length === 0 || item.id.length > limits.idLength) return null;
    if (ids.has(item.id)) return null;
    if (typeof item.at !== "string" || item.at.length > 40 || Number.isNaN(Date.parse(item.at))) return null;
    if (!isRecord(item.data)) return null;
    const clean = { id: item.id, at: item.at, data: item.data };
    if (encoder.encode(JSON.stringify(clean)).byteLength > limits.itemBytes) return null;
    ids.add(item.id);
    items.push(clean);
  }
  return { items, next: data.next ?? null, more: data.more === true };
}

/**
 * One courier run: for every receiver, ask what it wants, ask each sender for
 * news since the receiver's bookmark, and hand it over with the new bookmark.
 * Never throws for a plugin's answer; every problem is in the report.
 */
export async function runCourier(runtime, options = {}) {
  // The locked limits are ceilings: a store may only lower them.
  const limits = Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([name, ceiling]) => {
    const asked = options.limits?.[name];
    return [name, Number.isInteger(asked) && asked > 0 ? Math.min(asked, ceiling) : ceiling];
  }));
  const { outboxes, inboxes, problems } = findDoors(runtime);
  const report = { receivers: 0, handoffs: 0, delivered: 0, unfinished: false, problems };
  const senders = new Set(outboxes);
  let budget = limits.handoffsPerRun;

  for (const receiver of inboxes) {
    const asked = await knock(runtime, receiver, INBOX_ROUTE, { courier: COURIER_VERSION, op: "wants" });
    if (!asked.ok) {
      // EmDash answers NOT_FOUND for a sandboxed plugin whose route list it has not read; that plugin takes no part.
      if (asked.code !== "NOT_FOUND") problems.push({ plugin: receiver, code: asked.code, route: INBOX_ROUTE });
      continue;
    }
    const wants = readWants(asked.data, limits);
    if (!wants) {
      problems.push({ plugin: receiver, code: "BAD_WANTS", route: INBOX_ROUTE });
      continue;
    }
    report.receivers += 1;

    for (const want of wants) {
      if (!senders.has(want.from)) {
        problems.push({ plugin: receiver, code: "SENDER_MISSING", from: want.from, topic: want.topic });
        continue;
      }
      let after = want.after;
      for (;;) {
        // Only handoffs spend the budget, so receivers with nothing new never hold up the ones after them.
        if (budget <= 0) {
          report.unfinished = true;
          return report;
        }
        const sent = await knock(runtime, want.from, OUTBOX_ROUTE, {
          courier: COURIER_VERSION,
          op: "since",
          topic: want.topic,
          after,
          limit: want.limit,
        });
        if (!sent.ok) {
          problems.push({ plugin: want.from, code: sent.code, route: OUTBOX_ROUTE, topic: want.topic });
          break;
        }
        const batch = readBatch(sent.data, limits, want.limit);
        if (!batch) {
          problems.push({ plugin: want.from, code: "BAD_BATCH", route: OUTBOX_ROUTE, topic: want.topic });
          break;
        }
        if (batch.items.length === 0 && batch.next === after) break;
        budget -= 1;
        const given = await knock(runtime, receiver, INBOX_ROUTE, {
          courier: COURIER_VERSION,
          op: "deliver",
          from: want.from,
          topic: want.topic,
          items: batch.items,
          after,
          next: batch.next,
        });
        if (!given.ok) {
          problems.push({ plugin: receiver, code: given.code, route: INBOX_ROUTE, from: want.from, topic: want.topic });
          break;
        }
        report.handoffs += 1;
        report.delivered += batch.items.length;
        // A sender that says "more" without moving its bookmark would loop; the rest waits for the next run.
        const moved = batch.next !== after;
        after = batch.next;
        if (!batch.more || batch.next === null || !moved) break;
      }
    }
  }
  return report;
}
