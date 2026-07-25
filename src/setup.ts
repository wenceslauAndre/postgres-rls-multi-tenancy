/**
 * Applies sql/ in order and seeds two organizations with a document each,
 * plus one user who belongs to both. Idempotent: safe to re-run.
 */
import { readFileSync } from "node:fs";
import { ownerPool } from "./db";

const FILES = ["01-schema.sql", "02-app-role.sql", "03-policies.sql"];

async function main() {
  for (const file of FILES) {
    await ownerPool.query(readFileSync(`sql/${file}`, "utf8"));
    console.log(`applied sql/${file}`);
  }

  // Seeded through the owner connection, which bypasses RLS — the same
  // exception real apps make for migrations and seeds.
  await ownerPool.query(`
    INSERT INTO organizations (id, name) VALUES
      ('11111111-1111-1111-1111-111111111111', 'Acme'),
      ('22222222-2222-2222-2222-222222222222', 'Globex')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO users (id, email) VALUES
      ('33333333-3333-3333-3333-333333333333', 'consultant@example.com')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO memberships (organization_id, user_id) VALUES
      ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333'),
      ('22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333')
    ON CONFLICT DO NOTHING;

    INSERT INTO documents (id, organization_id, title) VALUES
      ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 'Acme roadmap'),
      ('55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111', 'Acme salaries'),
      ('66666666-6666-6666-6666-666666666666', '22222222-2222-2222-2222-222222222222', 'Globex acquisition memo')
    ON CONFLICT (id) DO NOTHING;
  `);

  console.log("seeded 2 orgs, 3 documents, 1 user in both orgs");
  await ownerPool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
