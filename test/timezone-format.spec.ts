import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_TIME_ZONE,
  formatDateTime,
  formatDayLabel,
  resolvedTimeZone,
  setStoredTimeZone,
} from '@client/lib/timezone';

/**
 * These guard a class of bug TypeScript cannot: `Intl.DateTimeFormatOptions` allows
 * `dateStyle`/`timeStyle` alongside component options like `timeZoneName`, but
 * ECMA-402 throws `TypeError: Invalid option : option` at runtime when they're
 * combined. That crashed the job detail page once already.
 */
describe('timezone formatting', () => {
  beforeEach(() => {
    setStoredTimeZone(null);
  });

  const INSTANT = '2026-07-31T21:00:00.000Z';
  const DAY_OPTS: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' };

  /** Reference rendering in an explicit zone — avoids asserting a locale's field order. */
  const renderedIn = (zone: string, opts: Intl.DateTimeFormatOptions = DAY_OPTS) =>
    new Date(INSTANT).toLocaleString(undefined, { ...opts, timeZone: zone });

  it('defaults to UTC rather than the host time zone', () => {
    expect(resolvedTimeZone()).toBe(DEFAULT_TIME_ZONE);
    expect(formatDateTime(INSTANT, DAY_OPTS)).toBe(renderedIn('UTC'));
    // 21:00Z is 02:30 the NEXT day in IST, so these must differ — proving the
    // output isn't just silently following whatever zone the host is in.
    expect(renderedIn('UTC')).not.toBe(renderedIn('Asia/Kolkata'));
  });

  it('renders in the chosen zone once one is set', () => {
    setStoredTimeZone('Asia/Kolkata');
    expect(resolvedTimeZone()).toBe('Asia/Kolkata');
    expect(formatDateTime(INSTANT, DAY_OPTS)).toBe(renderedIn('Asia/Kolkata'));
    expect(formatDateTime(INSTANT, DAY_OPTS)).not.toBe(renderedIn('UTC'));
  });

  // Every option set the app actually passes must be a legal combination.
  const APP_OPTION_SETS: Array<[string, Intl.DateTimeFormatOptions]> = [
    ['default (dateStyle + timeStyle only)', { dateStyle: 'medium', timeStyle: 'short' }],
    ['jobs table', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }],
    ['job chips absolute', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    }],
    ['account signed-in', {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    }],
    ['repos last activity', { year: 'numeric', month: 'short', day: 'numeric' }],
  ];

  it.each(APP_OPTION_SETS)('formats without throwing: %s', (_label, options) => {
    expect(() => new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' }))
      .not.toThrow();
    expect(formatDateTime(INSTANT, options)).toBeTruthy();
  });

  // Exercises the real call site rather than a copy of its options, so the guard
  // can't drift away from the component it protects.
  it('formats the job-detail absolute stamp with its requested options', async () => {
    const { formatAbsoluteDate } = await import('@client/components/features/job-detail/job-chips');
    const stamp = formatAbsoluteDate(INSTANT);

    expect(stamp).toBeTruthy();
    // Asserting the zone name is present — not merely that it didn't throw. The
    // safety net inside formatDateTime swallows an illegal option combination and
    // silently re-formats WITHOUT the requested fields, so a "doesn't throw"
    // assertion would happily pass on the very bug this guards.
    expect(stamp).toMatch(/UTC|GMT/);

    expect(formatAbsoluteDate(null)).toBeUndefined();
    expect(formatAbsoluteDate('not-a-date')).toBeUndefined();
  });

  it('degrades instead of throwing on an illegal option combination', () => {
    const illegal = { dateStyle: 'medium', timeZoneName: 'short' } as Intl.DateTimeFormatOptions;
    expect(() => formatDateTime(INSTANT, illegal)).not.toThrow();
    expect(formatDateTime(INSTANT, illegal)).toBeTruthy();
  });

  it('degrades instead of throwing on an unknown time zone', () => {
    setStoredTimeZone('Mars/Olympus_Mons'); // rejected by the setter, so falls back
    expect(resolvedTimeZone()).toBe(DEFAULT_TIME_ZONE);
    expect(() => formatDateTime(INSTANT)).not.toThrow();
  });

  it('renders a day-only label verbatim, regardless of display zone', () => {
    const expected = new Date('2026-07-31T00:00:00Z')
      .toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    // A negative-offset display zone would shift a naively-parsed label back a day.
    setStoredTimeZone('America/New_York');
    expect(formatDayLabel('2026-07-31')).toBe(expected);
    setStoredTimeZone('Asia/Kolkata');
    expect(formatDayLabel('2026-07-31')).toBe(expected);
  });

  it('returns the input unchanged for unparseable values', () => {
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
    expect(formatDayLabel('nope')).toBe('nope');
  });
});
