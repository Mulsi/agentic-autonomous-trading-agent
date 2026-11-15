-- Custom SQL migration file, put your code below! --
-- research_reader: the read-only role that research/ connects as (SLICE_1_PLAN
-- D13). Roles belong to the whole server, so the role is created only when it
-- is missing, and its attributes are set either way. The password is a fixed
-- local-development value, like trader's. The app never loads it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'research_reader') THEN
    BEGIN
      CREATE ROLE research_reader;
    EXCEPTION
      -- Another database on this server is being migrated at the same moment.
      WHEN duplicate_object OR unique_violation THEN NULL;
    END;
  END IF;
END
$$;
--> statement-breakpoint
ALTER ROLE research_reader WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'research-local-dev-only';
--> statement-breakpoint
-- On top of the privileges below, which are the boundary.
ALTER ROLE research_reader SET default_transaction_read_only = on;
--> statement-breakpoint
-- Privileges in this database: connect, look up names in public, and read
-- every table in it, now and later.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO research_reader', current_database());
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO research_reader;
--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA public TO research_reader;
--> statement-breakpoint
-- Tables that the migrating role (trader) creates later in public.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO research_reader;
