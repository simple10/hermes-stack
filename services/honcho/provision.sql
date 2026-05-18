\set ON_ERROR_STOP on
SELECT 'CREATE ROLE honcho LOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'honcho') \gexec
ALTER ROLE honcho WITH PASSWORD :'pw';
SELECT 'CREATE DATABASE honcho OWNER honcho'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'honcho') \gexec
\connect honcho
CREATE EXTENSION IF NOT EXISTS vector;
GRANT ALL ON SCHEMA public TO honcho;
