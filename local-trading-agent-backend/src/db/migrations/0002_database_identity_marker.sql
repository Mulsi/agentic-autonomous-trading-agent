-- Custom SQL migration file, put your code below! --
-- The database identity marker (src/db/identity.ts): one UUID that Postgres
-- generates the first time this database is migrated, so every database gets
-- its own. The app reads it at boot and never writes it.
INSERT INTO "database_identity" ("marker") VALUES (gen_random_uuid());
