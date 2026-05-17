# 01b — Clone `hermes-agent` → `hermes`

**Goal:** Create the new production VM `hermes` as a clone of the frozen
`hermes-agent`, preserving all Hermes tuning + the repopulated native
Honcho/Postgres (the Phase-3 migration source). `hermes-agent` is never
modified.

**Done directly by the controller** (short, high-stakes, safety-
constrained) — not delegated.

## Sequence

1. Pre-check: `hermes-agent` running; no `hermes` machine yet.
2. `orb stop hermes-agent` (authorized; consistent clone).
3. `orb clone hermes-agent hermes` (CoW, copy-on-demand, stopped clone).
4. **Leave `hermes-agent` STOPPED** — deliberate: a stopped VM is a frozen,
   intact, restorable backup; avoids dual Telegram-gateway / resource
   conflicts from running two copies of the native stack. Restore for
   reference anytime with `orb start hermes-agent`. (User authorized
   stopping; not "modifying".)
5. `orb start hermes` — boot new prod clone.
6. Verify: `hermes` boots; its native `honcho-api`/`honcho-deriver`/
   `postgresql` come up `active` (repopulated Honcho data present = Phase-3
   pg_dump source). `hermes-agent` exists, **stopped, unmodified**.

## Acceptance

- `orb list` shows both `hermes` (running) and `hermes-agent` (stopped).
- In `hermes`: honcho-api, honcho-deriver, postgresql `active`; Honcho
  `postgres` DB has the repopulated data (non-empty workspace).
- `hermes-agent` not started, not modified (frozen backup).
