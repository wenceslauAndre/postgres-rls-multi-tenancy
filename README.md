# Multi-tenancy your database enforces

A minimal, runnable demonstration of tenant isolation done with Postgres Row
Level Security instead of `WHERE organization_id = $1`.

Four tables, three SQL files, no framework, no ORM. Clone it, point it at a
Postgres, and watch the database refuse to hand over another tenant's rows.

```
$ npm run leak

  Same query. Same policies. Different role.
  SELECT title FROM documents  — both inside Acme's tenant context

  as postgres (superuser — always exempt from RLS)
      Acme roadmap
      Acme salaries
      Globex acquisition memo
      3 rows — other tenants included

  as app_user (NOBYPASSRLS, owns nothing)
      Acme roadmap
      Acme salaries
      2 rows — Acme's only
```

---

## The problem

Nearly every multi-tenant application keeps its tenants apart the same way:

```sql
SELECT * FROM documents WHERE organization_id = $1
```

That line is load-bearing, and it is repeated in every query you will ever
write. Forget it once — in a new endpoint, in a join, in a hotfix at 2am, in
a report someone added last quarter — and one tenant reads another's data.
Nothing crashes. No test fails. You find out from a customer.

The filter is a convention, and conventions are enforced by memory.

## The approach

Push the rule down into the database, where forgetting it is not an option.

```sql
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON documents
  USING      (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
```

The application sets one session variable per transaction, right after it has
decided which organization the request belongs to:

```ts
await client.query("BEGIN");
await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
// every query in this transaction is now scoped, whether it says so or not
```

Now a forgotten `WHERE` returns zero rows instead of somebody else's data.
The bug becomes a visible blank page rather than a silent breach.

## Try it

```bash
git clone https://github.com/wenceslauAndre/postgres-rls-multi-tenancy
cd postgres-rls-multi-tenancy
npm install
cp .env.example .env

docker compose up -d      # or point .env at any Postgres you already have

npm run setup             # applies sql/, seeds two tenants
npm run leak              # the output at the top of this README
npm run side-channels     # two leaks that survive correct policies
npm run check             # the startup guard, against both connections
npm test                  # nine assertions
```

`npm test` asserts, against a live server:

```
  ✓ app connects as a role that cannot bypass RLS
  ✓ no org context → 0 rows (fail closed)
  ✓ Acme's context sees Acme's documents
  ✓ Acme's context cannot see Globex's documents
  ✓ WITH CHECK blocks writing a row into another org
  ✓ own_memberships_read lets a user list their orgs pre-context
  ✓ connection reused after a tenant tx → no ''::uuid crash
  ✓ same connection, A then B → B sees only B
  ✓ commit, rollback and abort all leave no tenant context
```

---

## The details that decide whether any of this works

Everything above is in most RLS tutorials. These usually are not, and without
them the policies are decorative.

### 1. Ownership is an exemption

Three kinds of role ignore row level security entirely:

| Role | Exempt? |
| --- | --- |
| superuser | always — `FORCE` does not contain it |
| role with `BYPASSRLS` | always |
| the table's owner | under `ENABLE`; contained by `FORCE` |

The role that runs your migrations is usually a superuser or the table owner.
If your application shares that connection string — the default in most
tutorials, ORM guides, and `docker-compose.yml` files — then it inherits the
exemption, and every policy you wrote does nothing.

So the app connects as a separate role that owns nothing:

```sql
CREATE ROLE app_user LOGIN PASSWORD '...' NOBYPASSRLS;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
```

Migrations keep using the owner. The app never does. That split is the
difference between real isolation and a schema that merely looks careful,
and it is the thing `npm run leak` exists to show.

`FORCE ROW LEVEL SECURITY` is worth adding anyway, as a seatbelt for the day
someone points the app at the wrong connection string.

### 2. `set_config` leaves an empty string behind, and pools remember

`set_config(name, value, true)` is transaction-local. When the transaction
ends, the custom setting does not become unset or `NULL` — it becomes the
**empty string**.

The mechanism is `RESET`. A transaction-local value expires when the
transaction ends and the setting falls back to its *reset value* — and a
custom GUC that was never globally `SET` has a reset value of the empty
string, because `set_config` is what brought the placeholder into existence
and there is no better default to give it. This is why `missing_ok = true`
does not save you: the setting is not missing. It exists, and it is empty.

On a pooled connection, that matters. The next request to reuse that
connection without setting an org context evaluates:

```sql
''::uuid
```

which raises `22P02 invalid input syntax for type uuid`. In practice that
shows up as an intermittent 500 on whichever page runs without a tenant
context — an organization switcher, a post-login redirect — and only after
some other request has already used that connection. It will not reproduce
on a fresh pool, which is what makes it miserable to track down.

`NULLIF(current_setting(...), '')` turns the empty string back into `NULL`.
`NULL` casts cleanly and matches no rows, so the failure mode is "you see
nothing" rather than a crash — or, worse, a fallback that shows everything.

`npm test` covers this from both ends: it reuses a connection after a tenant
transaction and requires zero rows and no error, and it checks that all three
ways a transaction can end leave the connection contextless. Measured, since
the difference is not obvious:

| after | `current_setting('app.current_org_id', true)` |
| --- | --- |
| a connection that never set it | `NULL` |
| `COMMIT` | `''` |
| `ROLLBACK` | `''` |
| an aborted transaction | `''` |

So there is no fourth case hiding behind an error path — every ending
converges on the empty string, and one `NULLIF` covers all of them. They
converge because they are the same `RESET`, not three separate code paths.

**This behaviour is not documented.** The customized-options page says only
that placeholders *"have no function until the module that defines them is
loaded"* — nothing about their type or reset value — and the `set_config` /
`current_setting` reference does not say what happens when a transaction-local
value expires. That gap is known upstream: there is an open pgsql-hackers
proposal from David G. Johnston to document exactly this, whose diff adds that
placeholders have *"string data type with reset value of empty string"* and
that `set_config()` creates placeholders implicitly.

[The proposal](https://www.postgresql.org/message-id/CAKFQuwY0SK6JdCci1VJX6xsztRXgGeVEY-grkENZx+3CZpyPcQ@mail.gmail.com)

Until it lands, the behaviour is real and unwritten — which is why the table
above is measured rather than cited.

### 3. `SECURITY DEFINER` hands the exemption straight back

This is the first trap again, through a door that does not look like a
connection at all.

A `SECURITY DEFINER` function executes with the privileges of the function's
*owner*, not the caller's. So if that owner is a superuser or holds
`BYPASSRLS`, row security is simply off inside the function body — and per
the table above, `FORCE` does not contain either of those two roles.

You can get the two-role split exactly right and then give the exemption back
through an audit trigger, a helper function, or an RPC endpoint that nobody
thinks of as a database connection:

```sql
-- rls is not in effect inside here if the owner is a superuser
CREATE FUNCTION log_access(doc_id uuid) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public   -- do this too; separate escalation path otherwise
AS $$ ... $$;
```

Worth grepping your schema for `SECURITY DEFINER` and checking that each one
either does not need containment, or filters by organization itself. Prefer
`SECURITY INVOKER` (the default) unless you have a specific reason.

---

## Make the role split an invariant, not a README

Everything above is a thing you can get right once and lose later. A test
proves the role is contained on the machine that ran the test. It says
nothing about the deployment where someone edited `DATABASE_URL` at 5pm on a
Friday, or the staging box that was pointed at the migration user "just to
unblock something".

So assert it at startup and refuse to boot:

```ts
import { assertRuntimeRoleIsContained, formatRoleEvidence } from "./assert-role";

const evidence = await assertRuntimeRoleIsContained(pool); // throws if exempt
console.log(formatRoleEvidence(evidence));
```

`npm run check` runs it against both connections, so you can see both
outcomes:

```
  PASS APP_DATABASE_URL
       [rls] contained: user=app_user superuser=false bypassrls=false owned_tables=0 row_security=on

  REFUSED OWNER_DATABASE_URL — as it should be
       Refusing to start: the database role "postgres" is exempt from row level
       security because it is a superuser, and it holds BYPASSRLS, and it owns 4
       table(s) in public. Every tenant isolation policy in this schema would be
       inert.
```

The log line matters as much as the throw. When something goes wrong at 3am,
"were we actually running with the contained role?" should be a `grep`, not
an archaeology project.

---

## What RLS does not do

Worth being clear, because it is easy to oversell:

- **It does not authorize.** RLS filters rows once you have set an org
  context. Deciding whether this user may enter that organization at all is
  application code, and it has to run *before* the context is set. This repo
  keeps that boundary explicit in `src/db.ts`.
- **It is a second line of defense, not a replacement for care.** Keep
  writing the `WHERE` clause. The point is that forgetting it stops being
  catastrophic.
- **It has a cost.** Policies are predicates on every query. Index the
  `organization_id` columns and check your plans; on the shapes here it is
  cheap, but "cheap" is not "free".
- **Bootstrap queries need an exception.** Looking up a session, or an invite
  by its token, happens before you know the tenant. Those go through the
  owner connection deliberately — a small, named, auditable list, not a
  habit.
- **Constraints leak across tenants, by design.** From the Postgres docs:
  *"Referential integrity checks, such as unique or primary key constraints
  and foreign key references, always bypass row security to ensure that data
  integrity is maintained."*

  So a global `UNIQUE` on an email, a slug, or a Stripe customer id is an
  oracle: tenant A inserts a colliding value, gets a unique violation back
  instead of a success, and has just learned that tenant B holds it. The
  `SELECT` path is filtered perfectly and the row still leaks through the
  error. Foreign keys do the same in the other direction — the reference
  resolves against rows the caller cannot read.

  Where a value only has to be unique *per tenant*, put the tenant in the
  constraint and the channel closes:

  ```sql
  UNIQUE (organization_id, email)   -- not UNIQUE (email)
  ```

  Where it genuinely has to be globally unique, schema design cannot remove
  the oracle. Not returning the constraint error verbatim narrows it; nothing
  closes it.

## Layout

```
sql/01-schema.sql      four tables
sql/02-app-role.sql    the low-privilege role — the part guides skip
sql/03-policies.sql    the policies, commented
src/db.ts              two pools, withTenantContext, withUserContext
src/assert-role.ts     the startup guard — call this before serving traffic
src/setup.ts           applies sql/, seeds two tenants
src/leak.ts            same query, two roles, different answers
src/side-channels.ts   the two leaks that survive correct policies
src/check.ts           runs the guard against both connections
src/test.ts            nine assertions against a live server
```

## Acknowledgements

The `SECURITY DEFINER` trap and the constraint oracle were both raised by
**Rahul S** in a discussion on dev.to. Neither was in the first version of
this repo, and both survive a correct two-role split — which is exactly the
kind of gap you do not find on your own.

The reset-value explanation above came from a reader on dev.to who hit the
same bug on a PostgREST stack, with `request.jwt.claim.sub` instead of
`app.current_org_id`. This repo had the measurement and called it "becomes
the empty string"; they supplied the mechanism that produces it. Two
independent reproductions, on different stacks, before anyone had written
it down.

## License

MIT. Take it, copy the pattern into your own project, no attribution needed.

---

I extracted this from [TenantForge](https://tenantforge.dev), a multi-tenant
SaaS starter built on the same pattern with auth, organizations, invites,
RBAC and Stripe already wired up. This repo is the idea; that one is the
finished application. The pattern here is free either way.
