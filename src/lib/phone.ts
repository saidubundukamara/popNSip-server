/**
 * Sierra Leone mobile numbers, normalised to E.164 with the leading '+'
 * (FR-SHOP-4).
 *
 * Stored with the '+'. Whapi wants it without — that strip happens at the
 * Whapi boundary and nowhere else.
 */

import { ValidationError } from '@/lib/errors';

export const SIERRA_LEONE_DIALLING_CODE = '232';

/** National subscriber numbers are 8 digits; these are the operator prefixes. */
const VALID_PREFIXES = ['21', '25', '30', '31', '32', '33', '34', '40', '44', '50', '55', '66', '72', '73', '74', '75', '76', '77', '78', '79', '80', '88', '90', '99'];

/**
 * Accepts what people actually type: `076 123456`, `76123456`, `+232 76 123456`,
 * `00232-76-123456`. Returns `+23276123456` or throws.
 */
export function normaliseSierraLeoneMobile(input: string): string {
  const digits = input.replace(/\D/g, '');

  if (digits.length === 0) {
    throw new ValidationError('Enter a phone number.', [{ path: 'phone', message: 'Required.' }]);
  }

  let national = digits;

  // Strip an international prefix, then the trunk '0', in that order — a
  // number may carry both (00232 076 …).
  if (national.startsWith(`00${SIERRA_LEONE_DIALLING_CODE}`)) {
    national = national.slice(2 + SIERRA_LEONE_DIALLING_CODE.length);
  } else if (national.startsWith(SIERRA_LEONE_DIALLING_CODE) && national.length > 9) {
    national = national.slice(SIERRA_LEONE_DIALLING_CODE.length);
  }

  if (national.startsWith('0')) national = national.slice(1);

  if (national.length !== 8) {
    throw new ValidationError('That does not look like a Sierra Leone mobile number.', [
      { path: 'phone', message: 'Enter 8 digits after the network code, e.g. 076 123456.' },
    ]);
  }

  if (!VALID_PREFIXES.includes(national.slice(0, 2))) {
    throw new ValidationError('That network code is not one we recognise.', [
      { path: 'phone', message: `Numbers start with ${VALID_PREFIXES.slice(0, 6).join(', ')} and similar.` },
    ]);
  }

  return `+${SIERRA_LEONE_DIALLING_CODE}${national}`;
}

/** Non-throwing form, for filtering rather than validating. */
export function isSierraLeoneMobile(input: string): boolean {
  try {
    normaliseSierraLeoneMobile(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * The digits to match a stored E.164 against, for search.
 *
 * Staff type what is written on a receipt — '077 900100' — but the column
 * holds '+23277900100', which does not contain that string. This strips the
 * trunk '0' and any dialling code so a `contains` finds the number either way,
 * and tolerates a partial ('77900') that `normaliseSierraLeoneMobile` would
 * rightly reject.
 */
export function phoneSearchFragment(input: string): string | null {
  let digits = input.replace(/\D/g, '');
  if (digits.length < 3) return null;

  if (digits.startsWith(`00${SIERRA_LEONE_DIALLING_CODE}`)) digits = digits.slice(2 + SIERRA_LEONE_DIALLING_CODE.length);
  else if (digits.startsWith(SIERRA_LEONE_DIALLING_CODE) && digits.length > 9) digits = digits.slice(SIERRA_LEONE_DIALLING_CODE.length);

  if (digits.startsWith('0')) digits = digits.slice(1);

  return digits.length >= 3 ? digits : null;
}

/** Whapi wants digits only. The only place the '+' comes off. */
export const toWhapiNumber = (e164: string): string => e164.replace(/^\+/, '');

/** `+23276123456` → `076 123456`, for display to a Sierra Leonean reader. */
export function formatLocal(e164: string): string {
  const national = e164.replace(`+${SIERRA_LEONE_DIALLING_CODE}`, '');
  if (national.length !== 8) return e164;
  return `0${national.slice(0, 2)} ${national.slice(2)}`;
}
