-- Add updated_at column to the organization table.
-- Existing rows get the current epoch (ms) as a sensible default.
ALTER TABLE `organization` ADD COLUMN `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000);
