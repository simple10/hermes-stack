-- Runs once on first cluster init (empty data dir), as POSTGRES superuser.
-- Passwords are injected at runtime by an entrypoint wrapper (see compose).
CREATE ROLE honcho LOGIN PASSWORD ':HONCHO_PW';
CREATE DATABASE honcho OWNER honcho;
CREATE ROLE litellm LOGIN PASSWORD ':LITELLM_PW';
CREATE DATABASE litellm OWNER litellm;
CREATE ROLE hindsight LOGIN PASSWORD ':HINDSIGHT_PW';
CREATE DATABASE hindsight OWNER hindsight;
\connect honcho
CREATE EXTENSION IF NOT EXISTS vector;
GRANT ALL ON SCHEMA public TO honcho;
\connect hindsight
CREATE EXTENSION IF NOT EXISTS vector;
GRANT ALL ON SCHEMA public TO hindsight;
