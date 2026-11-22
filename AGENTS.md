# Agent Contract

This public repository owns the DinkusKit courier: store code that carries news
between the plugins installed in one EmDash store. Keep it generic: site copy,
customer data, branding, credentials and production configuration do not
belong here. Assume every committed byte is public.

## The rule it follows

The owner locked how DinkusKit plugins exchange information on 22 Nov 2026
(`plugin-communication-rule-20261122`,
[docs/plugin-communication.md](https://github.com/dinkuskit/dinkuskit/blob/main/docs/plugin-communication.md)
in dinkuskit/dinkuskit). Do not reopen it here. In short:

- Same-store plugins talk through the store. Buyer details stay in the store.
- Two lanes: inline for anything a shopper waits on; the courier, about once a
  minute, for news that may arrive late. Every item has an id.
- The courier is dumb. It holds no shop logic and keeps nothing.
- It retires once EmDash ships plugin events, the plugins have moved to them,
  and the journeys pass on the beta store without it.

The door contract is [docs/doors.md](docs/doors.md).

## Boundary

- The courier never reads or writes a plugin's storage. It only calls the
  `courier/outbox` and `courier/inbox` routes.
- It calls every door with no person attached, through EmDash's
  `withEmDashRuntime`. Never add a code path that calls a door as a person, and
  never make a door public.
- Shop rules (when an order counts as shipped, who may sell a product) belong
  to the plugins, never here.
- No network calls, no hosted service, no database of its own.

## Running GrillTrack

Run `./scripts/agent-skills` first; it installs the pinned SaariusSkills
skills into ignored `.cursor/skills/`. Use
`./scripts/grilltrack --project . validate` or `show` for ledger reads. Only
the CLI changes `.grilltrack/`; never edit it by hand. A change to the door
contract or the limits is a ledger entry the owner approves first.

## Checks

Run `npm ci --ignore-scripts`, `npm run typecheck` and `npm test` before
pushing. The tests build a real EmDash runtime; keep every proof in
`tests/runtime.test.js` passing on EmDash 1.4.0 and 1.5.0 (CI runs both).

## Gates

Do not publish to npm, tag a release, deploy, merge, or change a live store
without the owner's explicit approval.
