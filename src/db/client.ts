import { PrismaPg } from '@prisma/adapter-pg';

import { env, isDevelopment } from '@/config/env';
import { PrismaClient } from '@/generated/prisma/client';

/**
 * The single PrismaClient for the process. Repositories receive it (or a
 * transaction client) by constructor injection — nothing else in the codebase
 * imports this module, and no route ever does.
 *
 * Prisma 7 connects through a driver adapter rather than a URL baked into the
 * schema, which is why the connection string is read from `config/env` here
 * instead of from `env("DATABASE_URL")` in schema.prisma.
 */
const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

export const prisma = new PrismaClient({
  adapter,
  log: isDevelopment ? ['warn', 'error'] : ['error'],
});

export type { Prisma } from '@/generated/prisma/client';
