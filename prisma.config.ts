import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  // The CLI (migrate, studio) reads this; the running app connects through the
  // adapter in src/db/client.ts instead. On Neon, DATABASE_URL is the pooled
  // (PgBouncer) endpoint and migrations need the direct one: advisory locks do
  // not survive transaction pooling.
  datasource: {
    url: process.env['DIRECT_DATABASE_URL'] ?? process.env['DATABASE_URL'],
  },
});
