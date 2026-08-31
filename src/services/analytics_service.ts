import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/db/client';
import { ValidationError } from '@/lib/errors';

/**
 * Analytics (PRD §11).
 *
 * The metric definitions are fixed by the PRD and implemented literally here,
 * because the whole point of §11 is that "revenue" means one thing everywhere.
 * Two of those definitions are easy to get subtly wrong and are called out at
 * their query:
 *
 *   * revenue counts COMPLETED orders only, by `placedAt`;
 *   * average order value is UNDEFINED when the count is zero — not zero.
 *
 * Raw SQL rather than Prisma's groupBy: date bucketing in a named timezone is
 * exactly what Postgres is good at and what an ORM makes awkward.
 */

export type Period = 'today' | '7d' | '30d' | 'custom';

/** A half-open range of LOCAL dates, resolved to instants by Postgres. */
export type DateRange = { fromLocalDate: string; toLocalDateExclusive: string; timezone: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Today where the restaurant is, not where the server is. */
export function localToday(timezone: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD, which is what Postgres wants.
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
}

/** Plain-date arithmetic. Safe because these are dates, not instants. */
export function addDays(localDate: string, days: number): string {
  const [year, month, day] = localDate.split('-').map(Number);
  const date = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function resolveRange(input: {
  period: Period;
  timezone: string;
  from?: string | undefined;
  to?: string | undefined;
  now?: Date;
}): DateRange {
  const today = localToday(input.timezone, input.now ?? new Date());

  if (input.period === 'custom') {
    const { from, to } = input;
    if (!from || !to || !ISO_DATE.test(from) || !ISO_DATE.test(to)) {
      throw new ValidationError('A custom range needs a start and end date.', [
        { path: 'from', message: 'Use YYYY-MM-DD.' },
      ]);
    }
    if (from > to) {
      throw new ValidationError('The start date is after the end date.', [
        { path: 'from', message: 'Start must not be after end.' },
      ]);
    }
    // Exclusive end, so the last day is included in full.
    return { fromLocalDate: from, toLocalDateExclusive: addDays(to, 1), timezone: input.timezone };
  }

  const spans: Record<Exclude<Period, 'custom'>, number> = { today: 0, '7d': 6, '30d': 29 };
  return {
    fromLocalDate: addDays(today, -spans[input.period]),
    toLocalDateExclusive: addDays(today, 1),
    timezone: input.timezone,
  };
}

/**
 * The order set every metric is computed over: COMPLETED only, by placedAt,
 * inside the range. `timestamp X AT TIME ZONE Z` turns a local wall-clock date
 * into the instant it began where the restaurant is — doing this arithmetic in
 * JavaScript is how a day boundary ends up an hour out.
 */
const completedOrders = (branchId: string, range: DateRange) => Prisma.sql`
  SELECT o.*
  FROM orders o
  WHERE o.branch_id = ${branchId}
    AND o.status = 'COMPLETED'
    AND o.placed_at >= (${range.fromLocalDate}::timestamp AT TIME ZONE ${range.timezone})
    AND o.placed_at <  (${range.toLocalDateExclusive}::timestamp AT TIME ZONE ${range.timezone})
`;

const asNumber = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));

// ─── summary ──────────────────────────────────────────────────────────────

export type Summary = {
  revenueMinor: number;
  orderCount: number;
  /** Null when there are no orders. The PRD asks for an em dash, not a zero. */
  averageOrderValueMinor: number | null;
  range: DateRange;
};

export async function getSummary(branchId: string, range: DateRange): Promise<Summary> {
  const rows = await prisma.$queryRaw<{ revenue: bigint | null; order_count: bigint }[]>`
    WITH completed AS (${completedOrders(branchId, range)})
    SELECT COALESCE(SUM(total_minor), 0)::bigint AS revenue, COUNT(*)::bigint AS order_count
    FROM completed
  `;

  const revenueMinor = asNumber(rows[0]?.revenue);
  const orderCount = asNumber(rows[0]?.order_count);

  return {
    revenueMinor,
    orderCount,
    // Not `revenue / count || 0`: an average of nothing is not zero, and a
    // zero here would read as "we sold nothing at all today".
    averageOrderValueMinor: orderCount === 0 ? null : Math.round(revenueMinor / orderCount),
    range,
  };
}

// ─── top items ────────────────────────────────────────────────────────────

export type TopItem = { menuItemId: string; name: string; quantity: number; revenueMinor: number };

export async function getTopItems(branchId: string, range: DateRange, limit = 10): Promise<TopItem[]> {
  const rows = await prisma.$queryRaw<
    { menu_item_id: string; name: string; quantity: bigint; revenue: bigint }[]
  >`
    WITH completed AS (${completedOrders(branchId, range)})
    SELECT
      oi.menu_item_id,
      -- Grouped by item, not by variant (PRD §11). The live name is shown, so
      -- a renamed dish reads as one row rather than two.
      COALESCE(MAX(mi.name), MAX(oi.item_name_snapshot)) AS name,
      SUM(oi.quantity)::bigint       AS quantity,
      SUM(oi.line_total_minor)::bigint AS revenue
    FROM order_items oi
    JOIN completed c ON c.id = oi.order_id
    LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
    GROUP BY oi.menu_item_id
    ORDER BY quantity DESC, revenue DESC
    LIMIT ${limit}
  `;

  return rows.map((row) => ({
    menuItemId: row.menu_item_id,
    name: row.name,
    quantity: asNumber(row.quantity),
    revenueMinor: asNumber(row.revenue),
  }));
}

// ─── orders by hour ───────────────────────────────────────────────────────

export type HourBucket = { hour: number; orderCount: number; revenueMinor: number };

export async function getOrdersByHour(branchId: string, range: DateRange): Promise<HourBucket[]> {
  const rows = await prisma.$queryRaw<{ hour: number; order_count: bigint; revenue: bigint }[]>`
    WITH completed AS (${completedOrders(branchId, range)})
    SELECT
      -- In the restaurant's timezone, not UTC: an evening service otherwise
      -- lands on the wrong side of midnight.
      EXTRACT(HOUR FROM (placed_at AT TIME ZONE ${range.timezone}))::int AS hour,
      COUNT(*)::bigint AS order_count,
      COALESCE(SUM(total_minor), 0)::bigint AS revenue
    FROM completed
    GROUP BY 1
    ORDER BY 1
  `;

  const byHour = new Map(rows.map((row) => [row.hour, row]));

  // Every hour is returned, including the quiet ones — a chart with gaps
  // reads as missing data rather than as a closed kitchen.
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    orderCount: asNumber(byHour.get(hour)?.order_count),
    revenueMinor: asNumber(byHour.get(hour)?.revenue),
  }));
}

// ─── splits ───────────────────────────────────────────────────────────────

export type Split = { key: string; orderCount: number; valueMinor: number };
export type Splits = { paymentMethod: Split[]; orderType: Split[] };

export async function getSplits(branchId: string, range: DateRange): Promise<Splits> {
  const [payment, type] = await Promise.all([
    prisma.$queryRaw<{ key: string; order_count: bigint; value: bigint }[]>`
      WITH completed AS (${completedOrders(branchId, range)}),
      settled AS (
        SELECT
          p.order_id,
          p.method::text AS method,
          SUM(p.amount_minor) AS settled_minor,
          -- PRD §11: an order paid several ways counts under whichever method
          -- settled the most. The method tiebreaks so the result is stable.
          ROW_NUMBER() OVER (
            PARTITION BY p.order_id
            ORDER BY SUM(p.amount_minor) DESC, p.method::text
          ) AS rank
        FROM payments p
        JOIN completed c ON c.id = p.order_id
        WHERE p.status = 'SUCCEEDED'
        GROUP BY p.order_id, p.method
      )
      SELECT
        -- A completed order with no successful payment is still revenue; it
        -- must appear somewhere rather than vanishing from the split.
        COALESCE(s.method, 'UNRECORDED') AS key,
        COUNT(*)::bigint AS order_count,
        COALESCE(SUM(c.total_minor), 0)::bigint AS value
      FROM completed c
      LEFT JOIN settled s ON s.order_id = c.id AND s.rank = 1
      GROUP BY 1
      ORDER BY value DESC
    `,
    prisma.$queryRaw<{ key: string; order_count: bigint; value: bigint }[]>`
      WITH completed AS (${completedOrders(branchId, range)})
      SELECT type::text AS key, COUNT(*)::bigint AS order_count,
             COALESCE(SUM(total_minor), 0)::bigint AS value
      FROM completed
      GROUP BY 1
      ORDER BY value DESC
    `,
  ]);

  const shape = (rows: { key: string; order_count: bigint; value: bigint }[]): Split[] =>
    rows.map((row) => ({
      key: row.key,
      orderCount: asNumber(row.order_count),
      valueMinor: asNumber(row.value),
    }));

  return { paymentMethod: shape(payment), orderType: shape(type) };
}
