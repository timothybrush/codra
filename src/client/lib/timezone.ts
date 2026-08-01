/**
 * Display timezone for dashboard timestamps.
 *
 * Every timestamp in Codra is STORED absolute — Postgres `TIMESTAMPTZ`, and the
 * server always emits `toISOString()` (UTC, `Z`) — so this module is purely about
 * presentation: which zone we render those instants in.
 *
 * The preference lives on the account record (`account_settings.timezone`) so it
 * follows the user across devices, and is mirrored into localStorage so the very
 * first paint doesn't have to wait on a fetch.
 *
 * When nothing is set the display zone is UTC — deliberately NOT the browser's
 * zone, so a timestamp reads the same for everyone until someone chooses
 * otherwise in account settings.
 */

const STORAGE_KEY = 'codra-timezone';

/** Display zone used when the account hasn't chosen one. */
export const DEFAULT_TIME_ZONE = 'UTC';

let cached: string | null | undefined;

/** The zone the user explicitly chose, or null when following the browser. */
export function getStoredTimeZone(): string | null {
  if (cached !== undefined) return cached;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    cached = raw && isSupportedTimeZone(raw) ? raw : null;
  } catch {
    cached = null;
  }
  return cached;
}

export function setStoredTimeZone(zone: string | null) {
  cached = zone && isSupportedTimeZone(zone) ? zone : null;
  try {
    if (cached) localStorage.setItem(STORAGE_KEY, cached);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Non-fatal: we still hold the value in memory for this session.
  }
}

export function isSupportedTimeZone(zone: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The zone used for formatting — the stored choice, else UTC. */
export function resolvedTimeZone(): string {
  return getStoredTimeZone() ?? DEFAULT_TIME_ZONE;
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIME_ZONE;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/** Short GMT offset label for a zone, e.g. "GMT+5:30" — used in the picker. */
export function timeZoneOffsetLabel(zone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

/**
 * Format an ISO/`Date` value in the user's display zone. Invalid input is returned
 * as-is rather than rendering "Invalid Date" into the UI.
 */
export function formatDateTime(
  value: string | number | Date,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  try {
    return date.toLocaleString(undefined, { ...options, timeZone: resolvedTimeZone() });
  } catch {
    // Never let a formatting-option problem escape: Intl throws a TypeError for an
    // unknown zone AND for illegal option combinations, and retrying with the same
    // `options` would just throw again and take the page down with it.
    try {
      return date.toLocaleString(undefined, { timeZone: resolvedTimeZone() });
    } catch {
      return date.toLocaleString();
    }
  }
}

/**
 * Format a date-ONLY value (`YYYY-MM-DD`, e.g. a stats day bucket that the server
 * already resolved into the display zone). Parsed and rendered as UTC so the label
 * is the literal day given — formatting it in another zone would shift it by one.
 */
export function formatDayLabel(
  day: string,
  options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' },
): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  try {
    return date.toLocaleDateString(undefined, { ...options, timeZone: 'UTC' });
  } catch {
    return day;
  }
}

/** A curated zone list for the picker; the browser's own zone is folded in. */
export const COMMON_TIME_ZONES: string[] = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Europe/Moscow',
  'Africa/Lagos',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Dhaka',
  'Asia/Bangkok',
  'Asia/Singapore',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Perth',
  'Australia/Sydney',
  'Pacific/Auckland',
];
