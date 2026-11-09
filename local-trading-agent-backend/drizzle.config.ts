import { defineConfig } from 'drizzle-kit';

// The URL comes from the process environment only; this file opens nothing.
// `generate` needs no database, so the credentials are left out when the URL
// is unset or blank, and `migrate` then refuses to run.
const url = process.env.DATABASE_URL;

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  migrations: { schema: 'drizzle', table: '__drizzle_migrations' },
  ...(url === undefined || url === '' ? {} : { dbCredentials: { url } }),
});
