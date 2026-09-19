/**
 * The Railway cron service's entry point: run every scheduled job once, then
 * exit. Railway starts it on a schedule (every 5 minutes, its minimum) and
 * expects the process to finish, so this must never hang.
 *
 * Imports nothing from src/: it needs no database and no env.ts validation,
 * only the API's job endpoints over HTTP. tsup builds it to dist/run_jobs.js,
 * so the cron container runs plain node.
 *
 * Order matters (see routes/jobs.ts): reconcile before expiry, so an order
 * whose webhook was lost is settled before expiry cancels it.
 *
 * Env: API_BASE_URL (the API service's public URL) and CRON_SECRET.
 */
const JOBS = ['reconcile-payments', 'expire-orders', 'flush-wa-queue'] as const;
const TIMEOUT_MS = 60_000;

const base = process.env.API_BASE_URL;
const secret = process.env.CRON_SECRET;
if (!base || !secret) {
  process.stderr.write('API_BASE_URL and CRON_SECRET are required.\n');
  process.exit(1);
}

let failed = false;

for (const job of JOBS) {
  try {
    const response = await fetch(new URL(`/api/jobs/${job}`, base), {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await response.text();
    if (!response.ok) {
      failed = true;
      process.stderr.write(`${job}: HTTP ${response.status} ${body}\n`);
    } else {
      process.stdout.write(`${job}: ${body}\n`);
    }
  } catch (error) {
    // One job failing does not skip the rest: expiry still matters when
    // reconciliation cannot reach Monime.
    failed = true;
    process.stderr.write(`${job}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

process.exit(failed ? 1 : 0);

// A module, so top-level await is allowed.
export {};
