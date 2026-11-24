# DinkusKit courier

Carries news between the plugins installed in one EmDash store.

EmDash runs each plugin in its own sandbox, and one plugin cannot call another.
The store's own server code can reach every plugin from the inside, so the
courier runs there, about once a minute: it asks each plugin that listens what
it wants, asks the plugin that sends for news since then, and hands it over.
It keeps nothing. Each receiving plugin keeps its own bookmark and ignores news
it already has, so a repeated run changes nothing.

It is a stopgap. It retires once EmDash ships plugin events and the plugins
have moved to them.

The contract a plugin implements is in [docs/doors.md](docs/doors.md).

## Add it to a store

The DinkusKit store template will run it from the timer it already has. Any other EmDash site on
Cloudflare, on EmDash 1.4.0 or later:

```sh
npm install github:dinkuskit/courier#<tag>
```

**Cloudflare.** Run it from the Worker's `scheduled()` handler, which a once a
minute Cron Trigger (`"triggers": { "crons": ["* * * * *"] }`) calls:

```ts
import { courierScheduled } from "@dinkuskit/courier/store";

export default {
  // ...your fetch handler
  scheduled: courierScheduled(),
};
```

If the Worker already has a `scheduled()` handler, call
`courierScheduled()(controller, env, ctx)` from it.

For EmDash Registry installs (whose runtime ids are opaque `r_...` hashes), the
courier resolves a receiver's requested sender slug (such as `dinkus-commerce`)
from EmDash's active `_plugin_state.registry_slug` rows and fails closed with
`SENDER_AMBIGUOUS` if more than one installed outbox matches. A store running
two installs side by side can pin one explicitly:

```ts
scheduled: courierScheduled({ senders: { "dinkus-commerce": "r_gshdrqaldna3r7sn" } }),
```

**Node.** Not yet: self-hosted stores are not supported, and the way a Node
store runs the courier will be decided when they are.

## Add doors to a plugin

```ts
import { inboxDoor, outboxDoor } from "@dinkuskit/courier/doors";

export default {
  routes: {
    "courier/outbox": outboxDoor({
      "order.shipped": async ({ after, limit }, ctx) => {
        // Read shipments after the bookmark `after`, at most `limit` of them.
        return { items, next, more };
      },
    }),
    "courier/inbox": inboxDoor({
      wants: [{ from: "dinkus-commerce", topic: "order.shipped" }],
      deliver: async ({ items }, ctx) => {
        // Save each item once, skipping ids already saved; return how many were new.
      },
    }),
  },
};
```

`courierStatus(ctx)` tells a receiving plugin's admin page whether the courier
is visiting, is late, or is missing.

## Proof

`npm test` runs a real EmDash runtime on Node's built-in SQLite with a sending
plugin, a receiving plugin, a plugin with no doors and one with a wrongly public
door. It shows that:

1. the courier finds the doors without the store naming any plugin;
2. it delivers with nobody signed in, carries only news since the bookmark, and
   a repeated delivery changes nothing;
3. a request from outside the store is refused before it reaches the plugin,
   and even the store's administrator is refused, through EmDash's own
   plugin-route policy code.

CI runs it on EmDash 1.4.0 and 1.5.0.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

Product and contract decisions are GrillTrack ledger entries in
`.grilltrack/`. Change them only with `./scripts/grilltrack --project .`.
