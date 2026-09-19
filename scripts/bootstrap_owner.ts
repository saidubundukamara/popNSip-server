import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

import argon2 from 'argon2';

import { prisma } from '@/db/client';
import { StaffRole } from '@/generated/prisma/enums';
import { normaliseSierraLeoneMobile } from '@/lib/phone';

/**
 * First-run setup for a production database: one branch and its OWNER.
 *
 * The seed refuses to run in production (it deletes data), and every other
 * way to create a staff account needs a signed-in owner — so without this a
 * freshly migrated database has no way in.
 *
 * Refuses to run once any staff account exists, so it cannot be used to mint
 * a second owner behind the dashboard's back. The password is generated and
 * printed once; change it from the dashboard after the first sign-in. That
 * keeps it out of shell history and CI logs of the command line.
 *
 * Run from your machine against the production database (Neon's URL):
 *
 *   DATABASE_URL='<neon url>' npm run bootstrap:owner -- \
 *     --email owner@example.com --name 'Full Name' \
 *     --branch 'popNsip Freetown' --address '12 Wilkinson Road, Freetown' \
 *     --phone '078 077127'
 *
 * Leave NODE_ENV unset: env.ts would otherwise demand every integration secret,
 * none of which this script uses.
 */

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    branch: { type: 'string' },
    address: { type: 'string' },
    phone: { type: 'string' },
  },
});

function required(key: keyof typeof values): string {
  const value = values[key]?.trim();
  if (!value) throw new Error(`--${key} is required.`);
  return value;
}

async function main(): Promise<void> {
  const email = required('email').toLowerCase();
  const name = required('name');
  const branchName = required('branch');
  const address = required('address');
  const phoneE164 = normaliseSierraLeoneMobile(required('phone'));

  if ((await prisma.staffUser.count()) > 0) {
    throw new Error('Staff accounts already exist. Add more from the dashboard, signed in as the owner.');
  }

  const password = randomBytes(12).toString('base64url');

  await prisma.$transaction(async (tx) => {
    const branch = (await tx.branch.findFirst()) ?? (await tx.branch.create({ data: { name: branchName, address, phoneE164 } }));
    await tx.staffUser.create({
      data: { branchId: branch.id, email, name, role: StaffRole.OWNER, passwordHash: await argon2.hash(password) },
    });
  });

  process.stdout.write(`Owner created: ${email}\nTemporary password (shown once): ${password}\n`);
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
