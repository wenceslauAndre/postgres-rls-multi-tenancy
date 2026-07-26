/**
 * Turns the two-role split from documentation into an executable invariant.
 *
 * Call this once at application startup, before serving anything. A test
 * proves the role is contained on the machine that ran the test; a startup
 * check proves it on the deployment that actually matters — the one where
 * someone edited DATABASE_URL at 5pm on a Friday.
 *
 * It also prints the evidence, so that "we did the role split" is something
 * you can grep for in logs during an incident rather than something you
 * have to take on faith.
 */
import type { Pool } from "pg";

export type RoleEvidence = {
  user: string;
  isSuperuser: boolean;
  canBypassRls: boolean;
  ownedTables: number;
  /** Session value of the row_security GUC: on | off | force. */
  rowSecurity: string;
};

const QUERY = `
  SELECT current_user                       AS "user",
         rolsuper                           AS "isSuperuser",
         rolbypassrls                       AS "canBypassRls",
         current_setting('row_security')    AS "rowSecurity",
         (SELECT count(*) FROM pg_tables
           WHERE schemaname = 'public' AND tableowner = current_user)::int AS "ownedTables"
    FROM pg_roles
   WHERE rolname = current_user
`;

export async function inspectRuntimeRole(pool: Pool): Promise<RoleEvidence> {
  const { rows } = await pool.query<RoleEvidence>(QUERY);
  const evidence = rows[0];
  if (!evidence) throw new Error("could not resolve current_user against pg_roles");
  return evidence;
}

/**
 * Throws unless the connected role is actually subject to row level security.
 *
 * Three independent exemptions have to be absent, not one. Checking only
 * rolbypassrls passes happily for a superuser, which ignores every policy in
 * the database.
 *
 * row_security is reported but not enforced on: when a non-exempt role has it
 * set to `off`, Postgres raises an error on any query that would apply a
 * policy rather than returning unfiltered rows. That fails closed already.
 */
export async function assertRuntimeRoleIsContained(pool: Pool): Promise<RoleEvidence> {
  const e = await inspectRuntimeRole(pool);

  const problems: string[] = [];
  if (e.isSuperuser) problems.push("it is a superuser");
  if (e.canBypassRls) problems.push("it holds BYPASSRLS");
  if (e.ownedTables > 0) {
    problems.push(
      `it owns ${e.ownedTables} table(s) in public (owners bypass RLS unless the table is FORCE'd)`,
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to start: the database role "${e.user}" is exempt from row level security because ` +
        `${problems.join(", and ")}. Every tenant isolation policy in this schema would be inert. ` +
        `Point the application at a role created like sql/02-app-role.sql, and keep the owning ` +
        `role for migrations only.`,
    );
  }

  return e;
}

/** One greppable line of deployment evidence. */
export function formatRoleEvidence(e: RoleEvidence): string {
  return (
    `[rls] contained: user=${e.user} superuser=${e.isSuperuser} ` +
    `bypassrls=${e.canBypassRls} owned_tables=${e.ownedTables} row_security=${e.rowSecurity}`
  );
}
