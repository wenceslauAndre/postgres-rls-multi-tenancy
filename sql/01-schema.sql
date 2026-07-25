-- Minimal multi-tenant schema. Four tables, no framework, no ORM.
--
-- `organizations` and `users` are global: there is no organization_id to
-- filter an organization row by, and a user exists before joining any org.
-- Everything else is tenant-scoped and gets RLS in 02-policies.sql.

CREATE TABLE IF NOT EXISTS organizations (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (organization_id, user_id)
);

-- The tenant-scoped business resource. Your real tables follow this shape:
-- an organization_id column, and the policy in 02-policies.sql.
CREATE TABLE IF NOT EXISTS documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title           text NOT NULL
);
