-- migrations/master/0003_tenant_pools_seed.sql
-- Seed the default tenant pool. In single-DB mode 'default' resolves to the
-- same binding as master (env.DB). In split mode it resolves to env.POOL_DEFAULT.
INSERT INTO tenant_pools (id, binding_name, created_at)
VALUES ('default', 'POOL_DEFAULT', unixepoch() * 1000)
ON CONFLICT (id) DO NOTHING;
