\set ON_ERROR_STOP on
-- role: create without password if absent, then always re-sync password.
-- :'pw' is a psql quoted-literal (safe); role/db names are literal here
-- (per-service file) so there is no identifier-interpolation footgun.
SELECT 'CREATE ROLE litellm LOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'litellm') \gexec
ALTER ROLE litellm WITH PASSWORD :'pw';
SELECT 'CREATE DATABASE litellm OWNER litellm'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'litellm') \gexec
