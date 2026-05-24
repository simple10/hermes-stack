# MissionControl

Multi-tenant master kanban API for coordinating tasks across agent instances.

See `docs/specs/2026-05-22-master-api-design.md` for the design.

## Quick start (contributor dev)

```
pnpm install
cp .env.example .dev.vars   # then edit
pnpm db:generate            # generate Drizzle schema from better-auth
pnpm db:migrate:local       # apply migrations to local D1
pnpm dev                    # wrangler dev
```
