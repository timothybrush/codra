import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@client/lib/api';
import { PageHeader } from '@client/components/layout/page-header';
import { Button, LinkButton } from '@client/components/ui/button';
import { Input } from '@client/components/ui/input';
import { Badge } from '@client/components/ui/badge';
import { Text } from '@client/components/ui/text';
import { Skeleton } from '@client/components/shared/skeleton';
import { LoadError } from '@client/components/shared/load-error';
import { SectionCard } from '@client/components/shared/section-card';
import { Select } from '@client/components/ui/select';
import { ExternalLink, Mail, Pencil, Check, X } from 'lucide-react';
import { GithubMark } from '@client/components/shared/github-mark';
import {
  COMMON_TIME_ZONES,
  DEFAULT_TIME_ZONE,
  browserTimeZone,
  formatDateTime,
  getStoredTimeZone,
  resolvedTimeZone,
  setStoredTimeZone,
  timeZoneOffsetLabel,
} from '@client/lib/timezone';
import type { AccountSettings, AuthSessionUser } from '@shared/api';

import { DetailGroup, RevealOnClick, DetailRow } from '@client/components/features/account/detail-rows';
/**
 * Explicit zone list - no "Automatic". Timestamps default to UTC until a zone is
 * chosen here, so they read identically for everyone out of the box. The viewer's
 * own browser zone is folded in so it's always selectable.
 */
function zoneOptions() {
  const zones = Array.from(new Set([DEFAULT_TIME_ZONE, ...COMMON_TIME_ZONES, browserTimeZone()]))
    .sort((a, b) => a.localeCompare(b));
  return zones.map((zone) => {
    const offset = timeZoneOffsetLabel(zone);
    return { value: zone, label: offset ? `${zone} · ${offset}` : zone };
  });
}


function formatDate(value: string) {
  return formatDateTime(value, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

export function AccountPage() {
  const [user, setUser] = useState<AuthSessionUser | null>(null);
  const [account, setAccount] = useState<AccountSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [savingZone, setSavingZone] = useState(false);
  // The picker is driven by state, not by reading localStorage during render -
  // a render-time read isn't reactive, so the control never reflected a save.
  const [zonePref, setZonePref] = useState<string | null>(() => getStoredTimeZone());

  const load = async () => {
    setError(null);
    try {
      const [session, accountRes] = await Promise.all([
        api.getSession(),
        api.getAccount().catch(() => null),
      ]);
      setUser(session.user);
      setAccount(accountRes?.account ?? null);
      // Mirror the server's choice locally so every other page formats in the
      // same zone without waiting on this request. Only when the account actually
      // loaded - a failed fetch must not silently reset the local preference.
      if (accountRes?.account) {
        setStoredTimeZone(accountRes.account.timezone ?? null);
        setZonePref(accountRes.account.timezone ?? null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load your account.');
    } finally {
      setLoading(false);
    }
  };

  const saveTimezone = async (zone: string) => {
    const previous = zonePref;
    // Optimistic: the control reflects the choice immediately, and reverts if the
    // server rejects it, so it never sits on a value that wasn't persisted.
    setZonePref(zone);
    setStoredTimeZone(zone);
    setSavingZone(true);
    try {
      const res = await api.updateAccountTimezone(zone);
      setAccount(res.account);
      setStoredTimeZone(res.account.timezone ?? null);
      setZonePref(res.account.timezone ?? null);
      toast.success('Time zone updated', {
        description: `Timestamps now show in ${resolvedTimeZone()}.`,
      });
    } catch (e) {
      setZonePref(previous);
      setStoredTimeZone(previous);
      toast.error('Could not update time zone', {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setSavingZone(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  // Built once: a fresh array each render gave the Select a new `options` identity
  // every pass, which re-fired its highlight/measure effects and made the open
  // panel jitter.
  const zoneOpts = useMemo(() => zoneOptions(), []);

  // The editable display name is the persisted account name, falling back to
  // the GitHub profile name (then login) until the user sets their own.
  const displayName =
    account?.accountName?.trim() || user?.name?.trim() || user?.login || 'GitHub user';
  const initial = displayName.charAt(0).toUpperCase();
  const profileUrl = user ? `https://github.com/${user.login}` : 'https://github.com';

  const startEditName = () => {
    setNameDraft(displayName);
    setEditingName(true);
  };

  const saveName = async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      toast.error('Name cannot be empty.');
      return;
    }
    setSavingName(true);
    try {
      const res = await api.updateAccountName(trimmed);
      setAccount(res.account);
      setEditingName(false);
      toast.success('Account name updated');
    } catch (e) {
      toast.error('Could not update name', {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setSavingName(false);
    }
  };

  // Skeletons stand in for content only - card chrome, section titles and row
  // labels stay rendered so the page doesn't reflow when data lands.
  const pending = loading || !user;

  return (
    <section className="page-enter flex flex-col gap-5 pb-20">
      <PageHeader
        title="Account"
        description="Your Codra profile and account details."
      />

      {error && (
        <LoadError
          title="Couldn't load your account"
          detail={error}
          onRetry={() => { setLoading(true); void load(); }}
          retrying={loading}
        />
      )}

      {(loading || user) && (
        <>
          {/* ── Identity ─────────────────────────────────────────────────── */}
          <section className="ui-panel min-w-0 overflow-hidden">
            <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:gap-5 sm:p-6">
              {pending ? (
                <Skeleton width={56} height={56} className="shrink-0 rounded-full" />
              ) : user!.avatarUrl ? (
                <img
                  src={user!.avatarUrl}
                  alt=""
                  className="h-14 w-14 shrink-0 rounded-full object-cover ring-1 ring-ui-line"
                />
              ) : (
                <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-ui-fill text-xl font-semibold text-ui-strong ring-1 ring-ui-line">
                  {initial}
                </span>
              )}

              <div className="min-w-0 flex-1">
                {pending ? (
                  <div className="space-y-2.5">
                    <Skeleton height={17} width={190} borderRadius={5} />
                    <Skeleton height={12} width={120} borderRadius={4} />
                  </div>
                ) : editingName ? (
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        value={nameDraft}
                        onChange={(e) => setNameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void saveName();
                          if (e.key === 'Escape') setEditingName(false);
                        }}
                        autoFocus
                        maxLength={120}
                        aria-label="Account name"
                        className="h-9 w-full max-w-xs"
                      />
                      <div className="flex items-center gap-1.5">
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={saveName}
                          loading={savingName}
                          icon={<Check size={13} />}
                        >
                          Save
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditingName(false)}
                          disabled={savingName}
                          icon={<X size={13} />}
                          className="text-ui-subtle hover:text-ui-default"
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                    <p className="mt-2 text-[11px] text-ui-subtle">
                      Enter to save · Esc to cancel - this name is used across Codra.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="group/name flex min-w-0 items-center gap-1.5">
                      <h2
                        className="truncate text-lg font-bold text-ui-strong"
                        style={{ letterSpacing: '-0.01em' }}
                      >
                        {displayName}
                      </h2>
                      <button
                        type="button"
                        onClick={startEditName}
                        aria-label="Edit account name"
                        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ui-subtle transition-colors hover:bg-ui-fill hover:text-ui-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Pencil size={13} />
                      </button>
                    </div>
                    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
                      <span className="truncate text-[13px] text-ui-default dark:text-ui-subtle">
                        @{user!.login}
                      </span>
                      <Badge variant="secondary" className="shrink-0 gap-1.5">
                        <GithubMark size={11} />
                        GitHub
                      </Badge>
                    </div>
                  </>
                )}
              </div>

              {pending ? (
                <Skeleton width={148} height={32} borderRadius={6} className="shrink-0" />
              ) : (
                <LinkButton
                  href={profileUrl}
                  external
                  variant="secondary"
                  size="sm"
                  icon={<GithubMark size={14} />}
                  className="shrink-0 self-start sm:self-auto"
                >
                  View on GitHub
                  <ExternalLink size={12} className="text-ui-subtle" />
                </LinkButton>
              )}
            </div>
          </section>

          {/* ── Details ──────────────────────────────────────────────────── */}
          <SectionCard
            title="Details"
          >
            <div className="space-y-4 p-5">
              <DetailGroup caption="Profile">
                <DetailRow label="Name" loading={pending} skeletonWidth={140}>
                  {displayName}
                </DetailRow>
                <DetailRow label="Email" loading={pending} skeletonWidth={170}>
                  {user?.email ? (
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      <Mail size={13} className="shrink-0 text-ui-subtle" />
                      <span className="truncate">{user.email}</span>
                    </span>
                  ) : (
                    <span className="font-normal text-ui-subtle">Not provided</span>
                  )}
                </DetailRow>
              </DetailGroup>

              <DetailGroup caption="GitHub">
                <DetailRow label="GitHub username" loading={pending} skeletonWidth={120}>
                  @{user?.login}
                </DetailRow>
                <DetailRow label="GitHub user ID" mono loading={pending} skeletonWidth={80}>
                  {user?.githubUserId}
                </DetailRow>
              </DetailGroup>

              <DetailGroup caption="Codra account">
                {(pending || account) && (
                  <DetailRow label="Account ID" mono loading={pending} skeletonWidth={230}>
                    <RevealOnClick label="account ID">{account?.id}</RevealOnClick>
                  </DetailRow>
                )}
                <DetailRow label="Signed in" mono loading={pending} skeletonWidth={190}>
                  {user ? formatDate(user.signedInAt) : null}
                </DetailRow>

                {/* Display time zone. Timestamps are stored absolute (UTC); this only
                    controls how they're rendered across the dashboard. */}
                <div className="flex items-center justify-between gap-4 px-4 py-3">
                  <span className="min-w-0 shrink-0">
                    <Text variant="body" size="sm" bold as="span" className="text-[13px] dark:text-ui-subtle">
                      Date &amp; time zone
                    </Text>
                    <span className="mt-0.5 block text-[11px] leading-tight text-ui-subtle">
                      Stored in UTC, shown in {resolvedTimeZone()}
                    </span>
                  </span>
                  {pending ? (
                    <Skeleton height={32} width={200} borderRadius={7} />
                  ) : (
                    <div className="w-[15rem] shrink-0">
                      <Select
                        value={zonePref ?? DEFAULT_TIME_ZONE}
                        onValueChange={(v) => { if (!savingZone) void saveTimezone(v); }}
                        options={zoneOpts}
                        variant="card"
                        triggerClassName="h-8 px-2.5 text-[13px]"
                      />
                    </div>
                  )}
                </div>
              </DetailGroup>
            </div>
          </SectionCard>
        </>
      )}
    </section>
  );
}
