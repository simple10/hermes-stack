\set ON_ERROR_STOP on
-- phoenix role + db on the shared pg (mirrors litellm/provision.sql). Phoenix
-- applies its own schema migrations against this db at startup. :'pw' is a
-- psql quoted-literal (safe); names are literal here (no interpolation footgun).
SELECT 'CREATE ROLE phoenix LOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'phoenix') \gexec
ALTER ROLE phoenix WITH PASSWORD :'pw';
SELECT 'CREATE DATABASE phoenix OWNER phoenix'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'phoenix') \gexec
