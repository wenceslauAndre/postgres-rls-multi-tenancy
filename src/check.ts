/**
 * What you would call at application startup. Run with `npm run check`.
 *
 * Runs the guard against both connections so the difference is visible: the
 * app's role passes and prints its evidence line, the migration role is
 * refused with the reason.
 */
import { appPool, ownerPool } from "./db";
import { assertRuntimeRoleIsContained, formatRoleEvidence } from "./assert-role";

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

async function main() {
  console.log();
  console.log(bold("  Startup guard"));
  console.log(dim("  the role split, asserted at boot instead of documented in a README"));
  console.log();

  let failed = false;

  try {
    const evidence = await assertRuntimeRoleIsContained(appPool);
    console.log(`  ${green("PASS")} ${dim("APP_DATABASE_URL")}`);
    console.log(`       ${formatRoleEvidence(evidence)}`);
  } catch (err) {
    failed = true;
    console.log(`  ${red("FAIL")} ${dim("APP_DATABASE_URL")}`);
    console.log(`       ${(err as Error).message}`);
  }

  console.log();

  // The same guard against the migration connection. This one is *supposed*
  // to be rejected — it is the connection you must never serve requests on.
  try {
    await assertRuntimeRoleIsContained(ownerPool);
    failed = true;
    console.log(`  ${red("UNEXPECTED")} ${dim("OWNER_DATABASE_URL")} passed the guard`);
    console.log(`       ${dim("the migration role should be exempt; check your .env")}`);
  } catch (err) {
    console.log(`  ${green("REFUSED")} ${dim("OWNER_DATABASE_URL — as it should be")}`);
    console.log(`       ${dim((err as Error).message)}`);
  }

  console.log();
  await appPool.end();
  await ownerPool.end();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
