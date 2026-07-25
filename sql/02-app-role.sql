-- The detail most RLS tutorials leave out.
--
-- A table's owner BYPASSES row level security. So do superusers, and so does
-- any role with the BYPASSRLS attribute. If your application connects with
-- the same role that ran your migrations — which is the default in almost
-- every tutorial, ORM guide and docker-compose file — then every policy you
-- just wrote is inert. It will be there in the schema, it will pass code
-- review, and it will filter nothing.
--
-- The fix is a second role. Migrations run as the owner; the application
-- connects as this one, which owns nothing and cannot opt out of RLS.
--
-- NOBYPASSRLS is the default for a fresh role, but it is spelled out here
-- because the entire security model depends on it. Be explicit about the
-- thing that is load-bearing.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_password' NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;

-- Deliberately NOT granted: table ownership, CREATE on the schema, BYPASSRLS,
-- and superuser. app_user can read and write rows. It cannot change the rules
-- that decide which rows those are.
