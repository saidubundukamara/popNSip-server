import { TZDate } from '@date-fns/tz';

import type { BranchModel } from '@/generated/prisma/models';
import { NotFoundError } from '@/lib/errors';
import { repositories as repos } from '@/repositories';

/**
 * Public settings, and the open/closed question (FR-SHOP-11).
 *
 * "Open" is evaluated in the branch's own timezone. Doing it in UTC would put
 * the restaurant's evening service on the wrong side of midnight.
 */

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

type Window = { open: string; close: string };

function windowsForDay(openingHours: unknown, dayKey: string): Window[] {
  if (typeof openingHours !== 'object' || openingHours === null) return [];
  const day = (openingHours as Record<string, unknown>)[dayKey];
  if (!Array.isArray(day)) return [];

  return day.filter(
    (entry): entry is Window =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as Window).open === 'string' &&
      typeof (entry as Window).close === 'string',
  );
}

/** 'HH:MM' → minutes since midnight, or null if it is not a time. */
function toMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  return hours * 60 + minutes;
}

export function isOpenAt(branch: BranchModel, at: Date): boolean {
  // A manual override wins outright: the shutter is down, whatever the table says.
  if (branch.isOpenOverride !== null) return branch.isOpenOverride;

  const local = new TZDate(at, branch.timezone);
  const nowMinutes = local.getHours() * 60 + local.getMinutes();
  const dayKey = DAY_KEYS[local.getDay()];
  if (!dayKey) return false;

  for (const window of windowsForDay(branch.openingHours, dayKey)) {
    const from = toMinutes(window.open);
    const to = toMinutes(window.close);
    if (from === null || to === null) continue;

    // A window that closes past midnight (22:00–02:00) belongs to this day
    // until it ends, so it is checked as two ranges rather than one.
    if (to <= from) {
      if (nowMinutes >= from || nowMinutes < to) return true;
    } else if (nowMinutes >= from && nowMinutes < to) {
      return true;
    }
  }

  return false;
}

export async function getPublicSettings(at: Date = new Date()) {
  const branch = await repos.branches.findFirst();
  if (!branch) throw new NotFoundError('No branch is configured.');

  return {
    branch: {
      id: branch.id,
      name: branch.name,
      address: branch.address,
      phoneE164: branch.phoneE164,
      currency: branch.currency,
      timezone: branch.timezone,
      openingHours: branch.openingHours,
    },
    isOpen: isOpenAt(branch, at),
    orderTypes: {
      delivery: branch.deliveryEnabled,
      pickup: branch.pickupEnabled,
      dineIn: branch.dineInEnabled,
    },
  };
}

/**
 * The manager's view of the branch. Everything the public settings endpoint
 * withholds, plus the switches that control the shop: the order types it
 * accepts and the WhatsApp bot's kill switch.
 */
export async function getBranchSettings() {
  const branch = await repos.branches.findFirst();
  if (!branch) throw new NotFoundError('No branch is configured.');

  return {
    id: branch.id,
    name: branch.name,
    address: branch.address,
    phoneE164: branch.phoneE164,
    timezone: branch.timezone,
    currency: branch.currency,
    openingHours: branch.openingHours,
    isOpenOverride: branch.isOpenOverride,
    botEnabled: branch.botEnabled,
    deliveryEnabled: branch.deliveryEnabled,
    pickupEnabled: branch.pickupEnabled,
    dineInEnabled: branch.dineInEnabled,
    isOpenNow: isOpenAt(branch, new Date()),
  };
}

/**
 * `timezone` and `currency` are deliberately absent. Analytics buckets by the
 * branch timezone in raw SQL and every stored amount is in the branch
 * currency, so changing either would silently reinterpret history rather than
 * change a setting.
 */
export type BranchSettingsPatch = Partial<
  Pick<
    BranchModel,
    | 'name'
    | 'address'
    | 'phoneE164'
    | 'isOpenOverride'
    | 'botEnabled'
    | 'deliveryEnabled'
    | 'pickupEnabled'
    | 'dineInEnabled'
  >
> & {
  /**
   * Prisma's update input for a Json column will not take `JsonValue` (it has
   * to leave room for `JsonNullValueInput`), so the shape is stated here and
   * the route's zod schema is what actually validates it.
   */
  openingHours?: Record<string, { open: string; close: string }[]>;
};

export async function updateBranchSettings(patch: BranchSettingsPatch) {
  const branch = await repos.branches.findFirst();
  if (!branch) throw new NotFoundError('No branch is configured.');

  await repos.branches.update(branch.id, patch);
  return getBranchSettings();
}
