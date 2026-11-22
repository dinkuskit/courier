# The courier's doors

Status: proposed on 22 Nov 2026 (decisions `courier-doors-20261122` and
`courier-limits-20261122`, waiting for the owner's approval). The rule this
follows was locked on 22 Nov 2026 as `plugin-communication-rule-20261122` in
[dinkuskit/dinkuskit](https://github.com/dinkuskit/dinkuskit/blob/main/docs/plugin-communication.md).

EmDash runs each plugin in its own sandbox, and one plugin cannot call another.
The courier is store code that carries news between them. This page is the
contract a plugin implements to take part.

## When to use the courier

Use it for news that may arrive about a minute late: an order shipped, for
Reviews; a scheduled product page published, for Commerce. When a shopper is
waiting, or a minute late costs money, ask inline during the request instead.

## The two doors

Both are private `POST` routes with the permission `plugins:manage`. Every
request body and answer carries `courier: 1`.

A door **refuses any call that carries a person** (error `COURIER_ONLY`). Over
HTTP, EmDash lets a request reach a private route only for a signed-in person
with the route's permission, and every API token belongs to a person. The
courier calls from the store's own code with no person. So a call with no
person is the courier, and anything else is refused, even the store's
administrator.

A door must never be public. The courier skips a public door and reports
`PUBLIC_DOOR`.

### `courier/outbox` (a plugin that sends news)

```json
{ "courier": 1, "op": "since", "topic": "order.shipped", "after": "41", "limit": 50 }
```

answers

```json
{
  "courier": 1,
  "items": [{ "id": "order-1042:shipment-1", "at": "2026-11-22T15:01:09Z", "data": { "orderId": "order-1042" } }],
  "next": "42",
  "more": false
}
```

- `after` is the receiver's bookmark, `null` the first time. Its meaning
  belongs to the sender: a sequence number, a time, a cursor.
- `next` is the bookmark after the last item given. `more` is `true` when news
  is still waiting after `next`.
- `id` is unique for the sender and topic, at most 200 characters. A second
  label on the same order is a new id.
- `at` is when it happened. `data` is a JSON object of at most 8 KB.
- An unknown topic answers `UNKNOWN_TOPIC`.
- The same item may be given again. A sender must not change what an id means.

### `courier/inbox` (a plugin that receives news)

```json
{ "courier": 1, "op": "wants" }
```

answers what it listens to and from which bookmark:

```json
{ "courier": 1, "wants": [{ "from": "dinkus-commerce", "topic": "order.shipped", "after": "41" }] }
```

Then, for each batch:

```json
{
  "courier": 1, "op": "deliver", "from": "dinkus-commerce", "topic": "order.shipped",
  "items": [], "after": "41", "next": "42"
}
```

answers `{ "courier": 1, "saved": 1, "moved": true }`.

- The receiver ignores an item id it already has.
- It moves its bookmark to `next` only after the items are saved, and only
  when its bookmark is still `after`. A slower, older run never moves it back.
- `from` is set by the courier: it is the plugin whose outbox it asked.
- The receiver keeps the time of the last `wants` call, so its admin page can
  say when the courier last came, or that it is missing.

## One run

1. List every installed plugin (trusted plugins from the site's config and
   Registry plugins) and keep those whose route list has a courier door. The
   store names no plugin.
2. For each inbox: ask `wants`. For each wanted topic, ask the sender's outbox
   `since` the bookmark and `deliver` the batch, until the sender says there is
   no more.
3. Stop at the run's limits; the next run carries the rest.

A batch that is out of shape (an item over 8 KB, a repeated or missing id, a
bad time, more than 50 items) is not delivered, so the receiver's bookmark
stays where it was. A sender that is not installed is reported as
`SENDER_MISSING`.

## Limits of one run

| Limit | Value |
| --- | --- |
| Items in one handoff | 50 |
| Handoffs in one run, across every receiver | 20 |
| Bytes in one item | 8 KB |
| Topics one receiver may want | 20 |
| Characters in an id | 200 |

Shopify's REST API pages 50 records by default. WordPress runs timed jobs at
most once every 60 seconds.

## Helpers

`@dinkuskit/courier/doors` has `outboxDoor`, `inboxDoor` and `courierStatus`.
They hold the guard, the request checks and the bookmark bookkeeping, for
sandboxed and trusted plugins. They import only `PluginRouteError` from
`emdash` and add about 2.7 KB minified to a plugin that uses both doors. A
plugin may write its own doors to this contract instead.

## How the big platforms do it

- Shopify pushes an `orders/fulfilled` webhook to apps, and tells apps to also
  run reconciliation jobs that fetch what changed. The courier is that fetch,
  run by the store.
- WooCommerce fires `woocommerce_order_status_completed` inside the same
  process.
- WordPress runs timed jobs on page load, at most once every 60 seconds.
