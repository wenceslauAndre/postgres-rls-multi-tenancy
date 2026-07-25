-- The whole pattern, in about twenty lines.
--
-- Each policy compares the row's organization_id against a session variable
-- that the application sets, per transaction, right after it has decided
-- which organization this request belongs to.
--
-- Two details below are the difference between working RLS and decorative
-- RLS. Both are explained in the README; both are asserted in test.ts.

-- ---------------------------------------------------------------------------
-- Detail 1: FORCE.
--
-- ENABLE ROW LEVEL SECURITY still exempts the table's OWNER. FORCE removes
-- that exemption. It is a seatbelt: the app should never connect as the owner
-- anyway (see 03-app-role.sql), but if it ever does, FORCE means the policies
-- still apply instead of silently doing nothing.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Detail 2: NULLIF(current_setting(...), '').
--
-- set_config(..., true) is transaction-local, and when that transaction ends
-- the custom GUC reverts to the EMPTY STRING — not to NULL, not to unset.
-- On a pooled connection, the next request to reuse that connection without
-- setting an org context would evaluate ''::uuid and raise 22P02.
--
-- NULLIF turns '' back into NULL. NULL casts cleanly and matches no rows,
-- so the failure mode is "you see nothing", never "you see everything" and
-- never a 500. Fail closed.
-- ---------------------------------------------------------------------------

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON documents;
CREATE POLICY tenant_isolation ON documents
  USING      (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON memberships;
CREATE POLICY tenant_isolation ON memberships
  USING      (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- A second, SELECT-only policy. Postgres OR's permissive policies together,
-- so this widens reads without touching writes.
--
-- It exists for the chicken-and-egg case every multi-tenant app has: right
-- after login you must list the organizations a user belongs to, and you do
-- not have an org context yet — that list is what chooses it. Scoped to the
-- user's own rows, so it is not a hole.
DROP POLICY IF EXISTS own_memberships_read ON memberships;
CREATE POLICY own_memberships_read ON memberships
  FOR SELECT
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
