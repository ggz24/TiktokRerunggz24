# API database schema v2

This workspace owns the reviewed Prisma schema and its initial PostgreSQL migration.
The migration creates the v2 tables and enum types; it does not modify the existing
`livehub_account_imports` table used by the account import flow.

From the repository root, validate and generate the Prisma Client with:

```powershell
npm run db:validate --workspace @live-hub/api
npm run db:generate --workspace @live-hub/api
```

Apply pending migrations to the configured development database with:

```powershell
npm run db:migrate:dev --workspace @live-hub/api
```

Set `DATABASE_URL` to the API development PostgreSQL database before running the
migration. Do not use `migrate reset` on a database that contains data.

The SQL migration also installs the v2 `updated_at` triggers. Prisma's
`@updatedAt` annotation remains in the schema for Client writes, while the triggers
cover direct SQL updates. PostgreSQL enums enforce the allowed values represented
as `CHECK` constraints in the standalone SQL draft. The migration follows the
reviewed Prisma schema for defaults, including `licenses.plan = BASIC`.
