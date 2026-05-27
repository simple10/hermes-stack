# pg

`pgvector/pgvector` (postgres + pgvector extension). Shared substrate
backend for `honcho`, `hindsight`, `litellm`. Each consumer owns its own
role + db; this service just runs postgres.

Auto-pulled by `SERVICE_REQUIRES=pg` in any consuming service (or enable
directly: `just enable pg`).

## Lever

```
PG_VERSION=pg18
```

## Volume lifecycle

Data volume is `<project>_pg-data`. To recreate from scratch (new
passwords, new role/db provisioning): stop the stack, `docker volume rm
<project>_pg-data`, `just start`. The `POSTGRES_SUPERPASS` is regenerated
by `services/pg/build.ts` on first build into
`.stack/pg/.generated.env` (gen-once + reused to keep matching the
volume).
