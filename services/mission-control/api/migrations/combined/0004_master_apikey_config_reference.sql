-- better-auth 1.6+ added two required fields on the apikey table:
--   config_id    — scopes the key to one of the plugin's `configurations`.
--                  Always 'default' for us (no custom configurations defined).
--   reference_id — owner-of-record (user id for user-owned keys; org id for
--                  org-owned keys). We mint user-owned keys, so this is userId.
--
-- Existing rows from earlier migrations need backfilled values. config_id
-- defaults to 'default'; reference_id is backfilled to user_id (the closest
-- equivalent for legacy rows — they were all user-owned).

ALTER TABLE apiKey ADD COLUMN config_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE apiKey ADD COLUMN reference_id TEXT NOT NULL DEFAULT '';

UPDATE apiKey SET reference_id = user_id WHERE reference_id = '';

CREATE INDEX IF NOT EXISTS api_key_config ON apiKey (config_id);
CREATE INDEX IF NOT EXISTS api_key_reference ON apiKey (reference_id);
