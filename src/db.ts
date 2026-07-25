import { Pool, type PoolClient } from "pg";

try {
  process.loadEnvFile(".env");
} catch {
  // fine if the vars come from the shell instead
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env first.`);
  return value;
}

/**
 * Owns the tables, runs the SQL in sql/. Bypasses RLS — that is the point of
 * keeping it separate. Nothing that serves a request should ever use it.
 */
export const ownerPool = new Pool({ connectionString: required("OWNER_DATABASE_URL") });

/**
 * What "the application" connects as: app_user, NOBYPASSRLS, owns nothing.
 *
 * max: 1 so the demos provably reuse a single physical connection. That is
 * not a recommendation for production — it is what makes the stale-GUC
 * assertion in test.ts meaningful rather than lucky.
 */
export const appPool = new Pool({ connectionString: required("APP_DATABASE_URL"), max: 1 });

/**
 * Runs `fn` with an organization context set for that transaction only.
 *
 * The third argument to set_config is `is_local` — it scopes the setting to
 * the current transaction, so it cannot leak into whatever the connection
 * pool serves next. (It reverts to '' rather than NULL, which is exactly why
 * the policies in sql/03-policies.sql wrap it in NULLIF.)
 *
 * Note what this function does NOT do: decide whether this user is allowed
 * into this organization. That check belongs in application code, before the
 * context is set. RLS filters rows within an org; it does not choose the org.
 */
export async function withTenantContext<T>(
  client: PoolClient,
  organizationId: string,
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [organizationId]);
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
    const result = await fn();
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/**
 * For the one query that legitimately spans organizations: "which orgs does
 * this user belong to?" — asked right after login, before an org is chosen.
 * Relies on the own_memberships_read policy, which only widens SELECT.
 */
export async function withUserContext<T>(
  client: PoolClient,
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
    const result = await fn();
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}
