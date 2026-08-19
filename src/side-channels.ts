/**
 * Two ways a tenant learns about another tenant's data while every policy is
 * working exactly as written.
 *
 * Run with `npm run side-channels`.
 *
 * `npm run leak` shows policies that are not applied at all. This shows the
 * harder case: the role is contained, FORCE is on, USING and WITH CHECK are
 * both present and correct — and data still crosses, because neither of these
 * paths goes through the read path a policy filters.
 *
 *   1. SECURITY DEFINER  — the function body runs as the function's OWNER.
 *                          If that owner is a superuser, row security is off
 *                          inside it. FORCE does not contain a superuser; it
 *                          only removes the table owner's exemption.
 *
 *   2. constraint checks — from the Postgres docs on row security: "Referential
 *                          integrity checks, such as unique or primary key
 *                          constraints and foreign key references, always
 *                          bypass row security to ensure that data integrity is
 *                          maintained." A unique index cannot enforce
 *                          uniqueness against rows it is not allowed to see, so
 *                          it sees all of them — and reports collisions with
 *                          rows the caller cannot read.
 *
 * Everything this script creates, it drops again. The schema in sql/ models
 * the correct pattern on purpose; the anti-patterns below are built here,
 * shown, and removed, so nobody copies them out of the reference schema.
 */
import { appPool, ownerPool, withTenantContext } from "./db";

const ACME = "11111111-1111-1111-1111-111111111111";
const GLOBEX = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";

const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

type PgError = Error & { code?: string; constraint?: string };

async function main() {
  const owner = await ownerPool.connect();

  /**
   * Pin the message locale so this prints the same text on every machine —
   * a Postgres installed in pt-BR or de-DE returns translated error strings,
   * and the whole point here is a specific message. Reset in `finally`.
   * Requires the owner to be a superuser; harmless to skip if it is not.
   */
  const pinnedLocale = await owner
    .query(`ALTER ROLE app_user SET lc_messages = 'C'`)
    .then(() => true)
    .catch(() => false);

  const app = await appPool.connect();

  try {
    // -----------------------------------------------------------------
    // 1. SECURITY DEFINER hands the exemption back
    // -----------------------------------------------------------------
    await owner.query(`
      CREATE OR REPLACE FUNCTION document_count() RETURNS bigint
        LANGUAGE sql
        SECURITY DEFINER
      AS $$ SELECT count(*) FROM documents $$;
    `);
    await owner.query(`GRANT EXECUTE ON FUNCTION document_count() TO app_user`);

    const fn = (
      await owner.query<{ owner: string; is_super: boolean }>(`
        SELECT pg_get_userbyid(p.proowner) AS owner,
               r.rolsuper                  AS is_super
          FROM pg_proc p
          JOIN pg_roles r ON r.oid = p.proowner
         WHERE p.proname = 'document_count'
      `)
    ).rows[0];

    const forced = (
      await owner.query<{ forced: boolean }>(
        `SELECT relforcerowsecurity AS forced FROM pg_class WHERE relname = 'documents'`,
      )
    ).rows[0];

    const counts = await withTenantContext(app, ACME, USER, async () => ({
      me: (await app.query<{ me: string }>(`SELECT current_user AS me`)).rows[0],
      direct: (await app.query<{ n: string }>(`SELECT count(*) AS n FROM documents`)).rows[0],
      viaFn: (await app.query<{ n: string }>(`SELECT document_count() AS n`)).rows[0],
    }));

    console.log();
    console.log(bold("  1. SECURITY DEFINER"));
    console.log(
      dim(
        `  as ${counts.me?.me} · org context = Acme · documents has FORCE = ${forced?.forced}`,
      ),
    );
    console.log(dim(`  document_count() is owned by ${fn?.owner} (superuser = ${fn?.is_super})`));
    console.log();
    console.log(
      `      SELECT count(*) FROM documents   ${green(`${counts.direct?.n}`)}  ${dim("Acme's only, filtered")}`,
    );
    console.log(
      `      SELECT document_count()          ${red(`${counts.viaFn?.n}`)}  ${dim("every tenant's")}`,
    );
    console.log();
    console.log(dim("  FORCE is on and does not help: it removes the OWNER's exemption,"));
    console.log(dim("  and this function's owner is a superuser. Nothing removes that one."));
    console.log();

    // -----------------------------------------------------------------
    // 2. The constraint oracle
    // -----------------------------------------------------------------
    await owner.query(`DROP TABLE IF EXISTS projects`);
    await owner.query(`
      CREATE TABLE projects (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        slug            text NOT NULL UNIQUE   -- global on purpose: this is the oracle
      );
    `);
    await owner.query(`ALTER TABLE projects ENABLE ROW LEVEL SECURITY`);
    await owner.query(`ALTER TABLE projects FORCE ROW LEVEL SECURITY`);
    await owner.query(`
      CREATE POLICY tenant_isolation ON projects
        USING      (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
        WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
    `);
    await owner.query(`GRANT SELECT, INSERT ON projects TO app_user`);
    await owner.query(`INSERT INTO projects (organization_id, slug) VALUES ($1, 'project-atlas')`, [
      GLOBEX,
    ]);

    const visible = await withTenantContext(
      app,
      ACME,
      USER,
      async () =>
        (
          await app.query<{ n: string }>(
            `SELECT count(*) AS n FROM projects WHERE slug = 'project-atlas'`,
          )
        ).rows[0],
    );

    let collision: PgError | null = null;
    try {
      await withTenantContext(app, ACME, USER, () =>
        app.query(`INSERT INTO projects (organization_id, slug) VALUES ($1, 'project-atlas')`, [
          ACME,
        ]),
      );
    } catch (err) {
      collision = err as PgError;
    }

    console.log(bold("  2. The constraint oracle"));
    console.log(dim("  as app_user · org context = Acme · Globex owns the slug 'project-atlas'"));
    console.log();
    console.log(
      `      SELECT ... WHERE slug = 'project-atlas'   ${green(`${visible?.n} rows`)}  ${dim("correctly invisible")}`,
    );
    console.log(`      INSERT ... slug = 'project-atlas'`);
    console.log(`          ${red(`${collision?.code} ${collision?.message}`)}`);
    console.log(`          ${dim(`constraint: ${collision?.constraint}`)}`);
    console.log();
    console.log(dim("  The policy filtered the SELECT correctly. The row leaked through the ERROR."));
    console.log();

    // The fix: put the tenant in the constraint.
    await owner.query(`ALTER TABLE projects DROP CONSTRAINT projects_slug_key`);
    await owner.query(
      `ALTER TABLE projects ADD CONSTRAINT projects_org_slug_key UNIQUE (organization_id, slug)`,
    );

    let afterFix: string;
    try {
      await withTenantContext(app, ACME, USER, () =>
        app.query(`INSERT INTO projects (organization_id, slug) VALUES ($1, 'project-atlas')`, [
          ACME,
        ]),
      );
      afterFix = green("INSERT succeeded — no information crossed the boundary");
    } catch (err) {
      afterFix = red(`still failing: ${(err as PgError).code}`);
    }

    console.log(dim("  after UNIQUE (organization_id, slug) replaces UNIQUE (slug):"));
    console.log(`      ${afterFix}`);
    console.log();
    console.log(dim("  Same table, same data, same policy — only the constraint changed."));
    console.log(dim("  Globex still owns its slug and Acme still cannot see it."));
    console.log();
    console.log(
      dim("  Where a value must be unique GLOBALLY, schema design cannot close this."),
    );
    console.log(dim("  See the README: narrow the channel, and know that it is still there."));
    console.log();
  } finally {
    await owner.query(`DROP TABLE IF EXISTS projects`).catch(() => {});
    await owner.query(`DROP FUNCTION IF EXISTS document_count()`).catch(() => {});
    if (pinnedLocale) await owner.query(`ALTER ROLE app_user RESET lc_messages`).catch(() => {});
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
