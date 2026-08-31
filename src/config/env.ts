import { z } from 'zod';

/**
 * The only place in the server that reads `process.env`.
 *
 * Parsed once at boot so a missing variable fails here rather than at 8pm on a
 * Friday. Integration secrets are optional in development — you cannot hold a
 * Monime token to develop the menu screen — but required in production, where
 * a missing one is a silent outage.
 */

const nonEmpty = z.string().trim().min(1);

/** Absent in development, mandatory in production. */
const PRODUCTION_REQUIRED = [
  'MONIME_TOKEN',
  'MONIME_SPACE_ID',
  'MONIME_WEBHOOK_SECRET',
  'WHAPI_TOKEN',
  'WHAPI_NUMBER',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'CRON_SECRET',
] as const;

const envSchema = z
  .object({
    // ── core ──────────────────────────────────────────────────────────────
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().max(65535).default(4000),
    DATABASE_URL: nonEmpty.startsWith('postgres', 'must be a postgres:// or postgresql:// URL'),
    APP_BASE_URL: z.url({ message: 'must be an absolute URL, e.g. http://localhost:3000' }),
    API_BASE_URL: z.url({ message: 'must be an absolute URL, e.g. http://localhost:4000' }),
    SESSION_SECRET: nonEmpty.min(32, 'must be at least 32 chars — `openssl rand -base64 32`'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    // ── monime (mobile money) ─────────────────────────────────────────────
    MONIME_BASE_URL: z.url().default('https://api.monime.io/v1'),
    MONIME_TOKEN: nonEmpty.optional(),
    MONIME_SPACE_ID: nonEmpty.optional(),
    MONIME_VERSION: nonEmpty.default('caph.2025-08-23'),
    MONIME_WEBHOOK_SECRET: nonEmpty.optional(),

    // ── whapi (whatsapp) ──────────────────────────────────────────────────
    WHAPI_URL: z.url().default('https://gate.whapi.cloud'),
    WHAPI_TOKEN: nonEmpty.optional(),
    /** Stored E.164 with the `+`; stripped only at the Whapi boundary. */
    WHAPI_NUMBER: z
      .string()
      .regex(/^\+[1-9]\d{6,14}$/, 'must be E.164 with a leading +, e.g. +23278077127')
      .optional(),

    // ── cloudinary (media) ────────────────────────────────────────────────
    CLOUDINARY_CLOUD_NAME: nonEmpty.optional(),
    CLOUDINARY_API_KEY: nonEmpty.optional(),
    CLOUDINARY_API_SECRET: nonEmpty.optional(),

    // ── ops ───────────────────────────────────────────────────────────────
    RESTAURANT_TIMEZONE: nonEmpty.default('Africa/Freetown'),
    CRON_SECRET: nonEmpty.optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    for (const key of PRODUCTION_REQUIRED) {
      if (!env[key]) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'is required when NODE_ENV=production',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * A variable present but empty (`MONIME_TOKEN=` in a .env file) means the same
 * thing as an absent one. Without this, every blank line in .env.example fails
 * an `.optional()` check for being a zero-length string.
 */
function withoutBlanks(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.trim() !== '') result[key] = value;
  }
  return result;
}

function loadEnv(): Env {
  const parsed = envSchema.safeParse(withoutBlanks(process.env));

  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    // The logger depends on env, so this one message goes straight to stderr.
    process.stderr.write(`Invalid environment:\n${lines.join('\n')}\n\nSee .env.example.\n`);
    process.exit(1);
  }

  return parsed.data;
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';
