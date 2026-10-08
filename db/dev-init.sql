-- Local development only. Mounted by docker-compose.yml and run when the database
-- container is created for the first time. Never use these passwords anywhere else.
CREATE ROLE pharma_hub_app
  LOGIN PASSWORD 'app_dev_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
