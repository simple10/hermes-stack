\set ON_ERROR_STOP on
SELECT 'CREATE ROLE hindsight LOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hindsight') \gexec
ALTER ROLE hindsight WITH PASSWORD :'pw';
SELECT 'CREATE DATABASE hindsight OWNER hindsight'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'hindsight') \gexec
\connect hindsight
CREATE EXTENSION IF NOT EXISTS vector;
GRANT ALL ON SCHEMA public TO hindsight;
