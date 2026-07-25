/**
 * The same query, the same policies, two different database roles.
 *
 * Run with `npm run leak`. Show this to anyone who thinks that enabling RLS
 * is the whole job: the policies are identical and correct in both halves
 * below. Only the connection differs.
 *
 * Three roles are exempt from row level security:
 *
 *   - superusers                 always exempt, no way to force them
 *   - roles with BYPASSRLS       always exempt
 *   - the table's owner          exempt under ENABLE, contained under FORCE
 *
 * The role that runs your migrations is usually the first or the third. If
 * your application shares that connection string — the default in most
 * tutorials, ORM guides and compose files — it inherits the exemption.
 */
import { appPool, ownerPool, withTenantContext } from "./db";

const ACME = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";

const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

type RoleInfo = { me: string; super: boolean; bypass: boolean };

const WHOAMI = `
  SELECT current_user AS me,
         rolsuper     AS super,
         rolbypassrls AS bypass
    FROM pg_roles WHERE rolname = current_user
`;

function describe(r: RoleInfo | undefined): string {
  if (!r) return "unknown role";
  if (r.super) return "superuser — always exempt from RLS";
  if (r.bypass) return "BYPASSRLS — always exempt from RLS";
  return "NOBYPASSRLS, owns nothing";
}

async function main() {
  const owner = await ownerPool.connect();
  const app = await appPool.connect();

  console.log();
  console.log(bold("  Same query. Same policies. Different role."));
  console.log(dim("  SELECT title FROM documents  — both inside Acme's tenant context"));
  console.log();

  try {
    const ownerRole = (await owner.query<RoleInfo>(WHOAMI)).rows[0];
    const appRole = (await app.query<RoleInfo>(WHOAMI)).rows[0];

    const asOwner = await withTenantContext(owner, ACME, USER, () =>
      owner.query<{ title: string }>("SELECT title FROM documents ORDER BY title"),
    );
    const asApp = await withTenantContext(app, ACME, USER, () =>
      app.query<{ title: string }>("SELECT title FROM documents ORDER BY title"),
    );

    console.log(`  ${red(`as ${ownerRole?.me}`)} ${dim(`(${describe(ownerRole)})`)}`);
    for (const row of asOwner.rows) console.log(`      ${row.title}`);
    console.log(`      ${red(`${asOwner.rowCount} rows — other tenants included`)}`);
    console.log();

    console.log(`  ${green(`as ${appRole?.me}`)} ${dim(`(${describe(appRole)})`)}`);
    for (const row of asApp.rows) console.log(`      ${row.title}`);
    console.log(`      ${green(`${asApp.rowCount} rows — Acme's only`)}`);
    console.log();

    console.log(dim("  Nothing about the policies changed between those two queries."));
    console.log(dim("  Exemption is a property of the role. See sql/02-app-role.sql."));
    console.log();
  } finally {
    owner.release();
    app.release();
    await appPool.end();
    await ownerPool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
