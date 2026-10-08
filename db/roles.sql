-- Run once per database server, as an administrator, BEFORE the first migration:
--
--   psql "$ADMIN_DATABASE_URL" -v app_password='choose-a-long-random-password' -f db/roles.sql
--
-- pharma_hub_app is the role the application connects with. It must not be a superuser
-- and must not own the tables: PostgreSQL lets superusers and table owners bypass Row
-- Level Security, which would silently switch off the isolation between stores.
--
-- Migrations run with a different, more privileged connection (DATABASE_MIGRATION_URL).

CREATE ROLE pharma_hub_app
  LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
