/**
 * Seven assertions against a live Postgres. Run with `npm test`.
 *
 * Every one of these is a property of the database, not of application code.
 * A mocked query layer would pass all seven while the real thing leaked.
 */
import { appPool, ownerPool, withTenantContext, withUserContext } from "./db";

const ACME = "11111111-1111-1111-1111-111111111111";
const GLOBEX = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ${green("✓")} ${label}${detail ? " " + dim(detail) : ""}`);
  } else {
    failed++;
    console.log(`  ${red("✗")} ${label}${detail ? " " + dim(detail) : ""}`);
  }
}

async function main() {
  const client = await appPool.connect();

  console.log();
  console.log(bold("  Postgres RLS tenant isolation"));
  console.log(dim("  the database refuses cross-tenant rows — not the app layer"));
  console.log();

  try {
    // 1 — everything else is worthless if this is false. Three separate
    //     exemptions to rule out: superuser, BYPASSRLS, and table ownership
    //     (the last one contained by FORCE in sql/03-policies.sql).
    const role = await client.query<{
      me: string;
      super: boolean;
      bypass: boolean;
      owns: number;
    }>(`
      SELECT current_user AS me,
             rolsuper     AS super,
             rolbypassrls AS bypass,
             (SELECT count(*) FROM pg_tables
               WHERE schemaname = 'public' AND tableowner = current_user)::int AS owns
        FROM pg_roles WHERE rolname = current_user
    `);
    const r = role.rows[0];
    check(
      "app connects as a role that cannot bypass RLS",
      r?.super === false && r?.bypass === false && r?.owns === 0,
      `(${r?.me}: not superuser, NOBYPASSRLS, owns ${r?.owns} tables)`,
    );

    // 2 — before any context has ever been set on this connection.
    const cold = await client.query("SELECT id FROM documents");
    check("no org context → 0 rows (fail closed)", cold.rowCount === 0, `(${cold.rowCount} rows)`);

    // 3 & 4 — the isolation itself.
    const acme = await withTenantContext(client, ACME, USER, () =>
      client.query<{ organization_id: string }>("SELECT organization_id FROM documents"),
    );
    check("Acme's context sees Acme's documents", acme.rowCount === 2, `(${acme.rowCount} rows)`);
    check(
      "Acme's context cannot see Globex's documents",
      acme.rows.every((r) => r.organization_id === ACME),
      "(0 leaked)",
    );

    // 5 — reads are only half the problem. Without WITH CHECK, a tenant can
    //     write rows INTO another tenant even though it cannot read them.
    let code = "";
    try {
      await withTenantContext(client, ACME, USER, () =>
        client.query("INSERT INTO documents (organization_id, title) VALUES ($1, $2)", [
          GLOBEX,
          "planted",
        ]),
      );
    } catch (err) {
      code = (err as { code?: string }).code ?? "";
    }
    check(
      "WITH CHECK blocks writing a row into another org",
      code === "42501",
      code ? `(SQLSTATE ${code})` : "(no error raised — writes are NOT contained)",
    );

    // 6 — the org switcher has to keep working with no org chosen yet.
    const mine = await withUserContext(client, USER, () =>
      client.query("SELECT organization_id FROM memberships"),
    );
    check(
      "own_memberships_read lets a user list their orgs pre-context",
      mine.rowCount === 2,
      `(${mine.rowCount} orgs)`,
    );

    // 7 — the bug you only meet in production, on a recycled connection.
    let recycled = -1;
    let threw = "";
    try {
      const after = await client.query("SELECT id FROM documents");
      recycled = after.rowCount ?? -1;
    } catch (err) {
      threw = (err as { code?: string }).code ?? "unknown";
    }
    check(
      "connection reused after a tenant tx → no ''::uuid crash",
      threw === "" && recycled === 0,
      threw ? `(threw ${threw} on the stale GUC)` : `(${recycled} rows)`,
    );

    console.log();
    console.log(`  ${bold(`${passed} passed`)}, ${failed ? red(`${failed} failed`) : "0 failed"}`);
    console.log();
  } finally {
    client.release();
    await appPool.end();
    await ownerPool.end();
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
