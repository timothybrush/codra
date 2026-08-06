// Whether the runtime can actually format in this zone.
//
// Shared because it is validated in three places that must agree: the account settings API rejects
// an unsupported zone on write, the stats queries fall back to UTC on read, and the dashboard falls
// back before its first paint. Three copies meant three chances to disagree about what is storable.
export function isSupportedTimeZone(zone: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
