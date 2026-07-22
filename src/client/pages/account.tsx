import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@client/lib/api';
import { PageHeader } from '@client/components/layout/page-header';
import { Button } from '@client/components/ui/button';
import { Input } from '@client/components/ui/input';
import { Skeleton } from '@client/components/shared/skeleton';
import { LoadError } from '@client/components/shared/load-error';
import { ExternalLink, Mail, Pencil, Check, X } from 'lucide-react';
import { GithubMark } from '@client/components/shared/github-mark';
import type { AccountSettings, AuthSessionUser } from '@shared/api';

/* ── Section wrapper (matches the settings page chrome) ───────────────────── */
function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="ui-panel min-w-0 overflow-hidden">
      <div className="border-b border-ui-line px-5 py-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ui-default">{title}</h2>
        <p className="mt-0.5 text-xs text-ui-subtle">{description}</p>
      </div>
      {children}
    </section>
  );
}

/* ── One key/value detail row ─────────────────────────────────────────────── */
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3.5">
      <span className="shrink-0 text-[13px] font-medium text-ui-subtle">{label}</span>
      <span className="min-w-0 truncate text-right text-[13px] font-semibold text-ui-strong">{children}</span>
    </div>
  );
}

function formatDate(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
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

  const load = async () => {
    setError(null);
    try {
      const [session, accountRes] = await Promise.all([
        api.getSession(),
        api.getAccount().catch(() => null),
      ]);
      setUser(session.user);
      setAccount(accountRes?.account ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load your account.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

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

  return (
    <section className="page-enter flex flex-col gap-5 pb-20">
      <PageHeader
        category="Profile"
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

      {loading ? (
        <>
          <div className="ui-panel flex items-center gap-4 p-6">
            <Skeleton width={64} height={64} className="rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton height={18} width="40%" />
              <Skeleton height={13} width="28%" />
            </div>
          </div>
          <Skeleton height={200} />
        </>
      ) : user ? (
        <>
          {/* ── Identity ─────────────────────────────────────────────────── */}
          <section className="ui-panel overflow-hidden">
            <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:p-6">
              {user.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt=""
                  className="h-16 w-16 shrink-0 rounded-full object-cover ring-1 ring-ui-line"
                />
              ) : (
                <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-ui-fill text-2xl font-semibold text-ui-strong ring-1 ring-ui-line">
                  {initial}
                </span>
              )}
              <div className="min-w-0 flex-1">
                {editingName ? (
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
                      <Button size="sm" onClick={saveName} loading={savingName} icon={<Check size={14} />}>
                        Save
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditingName(false)}
                        disabled={savingName}
                        icon={<X size={14} />}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-lg font-bold text-ui-strong">{displayName}</h2>
                    <button
                      type="button"
                      onClick={startEditName}
                      aria-label="Edit account name"
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ui-subtle transition-colors hover:bg-ui-fill hover:text-ui-default"
                    >
                      <Pencil size={13} />
                    </button>
                  </div>
                )}
                <p className="mt-0.5 truncate text-sm text-ui-subtle">@{user.login}</p>
              </div>
              <a
                href={profileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex shrink-0 items-center gap-2 self-start rounded-md border border-ui-line bg-ui-base px-3 py-2 text-[13px] font-semibold text-ui-default transition-colors hover:bg-ui-fill sm:self-auto"
              >
                <GithubMark size={15} />
                View on GitHub
                <ExternalLink size={13} className="text-ui-subtle" />
              </a>
            </div>
          </section>

          {/* ── Details ──────────────────────────────────────────────────── */}
          <SectionCard title="Details" description="Your account details.">
            <div className="divide-y divide-ui-line">
              {account && (
                <DetailRow label="Account ID"><span className="ui-font-mono text-xs">{account.id}</span></DetailRow>
              )}
              <DetailRow label="Name">{displayName}</DetailRow>
              <DetailRow label="GitHub username">@{user.login}</DetailRow>
              <DetailRow label="GitHub user ID"><span className="ui-font-mono">{user.githubUserId}</span></DetailRow>
              <DetailRow label="Email">
                {user.email ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Mail size={13} className="text-ui-subtle" />
                    {user.email}
                  </span>
                ) : (
                  <span className="text-ui-subtle">Not provided</span>
                )}
              </DetailRow>
              <DetailRow label="Signed in">
                <span className="ui-font-mono text-ui-default">{formatDate(user.signedInAt)}</span>
              </DetailRow>
            </div>
          </SectionCard>
        </>
      ) : null}
    </section>
  );
}
