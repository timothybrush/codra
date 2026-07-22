import { NavLink, Outlet, Link, useMatch, useResolvedPath } from 'react-router-dom';
import { useEffect, useRef, useState, type ComponentType } from 'react';
import { SharedLayoutBg } from '@client/components/motion/shared-layout-bg';
import { api } from '@client/lib/api';
import {
  LayoutDashboard,
  AlignLeft,
  GitBranch,
  BarChart2,
  LogOut,
  Sun,
  Moon,
  Activity,
  Settings,
  Star,
  X,
  ChevronsUpDown,
  UserRound,
} from 'lucide-react';
import { GithubMark } from '@client/components/shared/github-mark';
import { cn } from '@client/lib/utils';
import { useTheme } from '@client/lib/theme';
import codraDark from '@/assets/codra-fullicon-dark.svg';
import codraLight from '@/assets/codra-fullicon-light.svg';
import type { AuthSessionUser } from '@shared/api';

const links = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/jobs', label: 'Jobs', icon: Activity, end: false },
  { to: '/repos', label: 'Repos', icon: GitBranch, end: false },
  { to: '/stats', label: 'Stats', icon: BarChart2, end: false },
  { to: '/settings', label: 'Settings', icon: Settings, end: false },
];

/**
 * A sidebar nav item that resolves active state via hooks instead of
 * NavLink's render-prop pattern, so SharedLayoutBg's cloneElement receives
 * plain JSX children rather than a function. Colours track the app's ui-*
 * / --primary tokens so the sidebar reads as the same system as the rest.
 */
function SidebarNavItem({
  to,
  end,
  label,
  icon: Icon,
  onClick,
}: {
  to: string;
  end: boolean;
  label: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  onClick: () => void;
}) {
  const resolved = useResolvedPath(to);
  const match = useMatch({ path: resolved.pathname, end });
  const isActive = match !== null;

  return (
    <NavLink
      to={to}
      end={end}
      onClick={onClick}
      className={cn(
        'dashboard-sidebar-action',
        'group flex h-10 w-full items-center gap-3 rounded-md pl-4 pr-3.5 text-[13px] font-medium',
        'outline-none transition-[color,background-color] duration-200 ease-[var(--ease-out-quart)]',
        'focus-visible:ring-2 focus-visible:ring-ring',
        isActive
          ? 'bg-ui-fill/60 font-semibold text-ui-strong'
          : 'text-ui-default hover:text-ui-strong dark:text-ui-subtle dark:hover:text-ui-default',
      )}
    >
      {/* Active accent bar (brand) */}
      <span
        className={cn(
          'absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-[var(--btn-primary-bg)]',
          'z-20 transition-opacity duration-200',
          isActive ? 'opacity-100' : 'opacity-0',
        )}
      />

      {/* Skimmer shine — a brand-tinted light beam that sweeps across when the
          selected row is hovered (CSS in app.css). Only rendered when active. */}
      {isActive && (
        <span
          className="pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-md"
          aria-hidden="true"
        >
          <span className="dashboard-sidebar-shine absolute inset-0 flex justify-center">
            <span className="h-full w-12 bg-gradient-to-r from-transparent via-[var(--btn-primary-bg)]/30 to-transparent" />
          </span>
        </span>
      )}

      {/* Icon */}
      <span className="relative z-10 flex shrink-0 items-center justify-center">
        <Icon size={15} strokeWidth={isActive ? 2.4 : 2} />
      </span>

      {/* Label */}
      <span className="relative z-10 min-w-0 flex-1 truncate">
        {label}
      </span>
    </NavLink>
  );
}

/**
 * Account menu, built from scratch (no shared dropdown primitives): a local
 * popover anchored to the account row via plain CSS (`absolute bottom-full`),
 * so it always opens directly above the row and moves with the sidebar.
 * Outside-click and Escape close it; focus returns to the trigger.
 */
function AccountMenu({ user }: { user: AuthSessionUser }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const name = user.name?.trim() || user.login;
  const initial = name.charAt(0).toUpperCase();

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">

      {/* Panel — a clean action menu anchored above the row. Identity lives in
          the trigger below, so the panel is purely actions (no duplication).
          It stays mounted and animates via CSS; when closed it is `invisible`
          + `pointer-events-none` so the transparent panel can never sit on top
          of the rows behind it and swallow their hover/clicks. */}
      <div
        role="menu"
        aria-hidden={!open}
        style={{ transformOrigin: 'bottom center' }}
        className={cn(
          'absolute bottom-[calc(100%+0.5rem)] left-0 right-0 z-50',
          'rounded-xl border border-ui-line bg-ui-base p-1.5',
          'shadow-[0_12px_32px_-10px_oklch(0%_0_0/0.22)] dark:shadow-[0_12px_32px_-10px_oklch(0%_0_0/0.7)]',
          'transition-[opacity,transform,visibility] duration-150 ease-[var(--ease-out-quart)]',
          open
            ? 'visible translate-y-0 scale-100 opacity-100'
            : 'invisible pointer-events-none translate-y-1 scale-95 opacity-0',
        )}
      >
        <Link
          role="menuitem"
          to="/account"
          tabIndex={open ? 0 : -1}
          className={cn(
            'group/item flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] font-medium text-ui-default',
            'outline-none transition-colors duration-150',
            'hover:bg-ui-fill/70 focus-visible:bg-ui-fill/70',
          )}
          onClick={() => setOpen(false)}
        >
          <UserRound size={15} strokeWidth={2} className="shrink-0 text-ui-subtle transition-colors group-hover/item:text-ui-default" />
          <span className="min-w-0 flex-1 truncate">Account</span>
        </Link>

        <a
          role="menuitem"
          href={`https://github.com/${user.login}`}
          target="_blank"
          rel="noopener noreferrer"
          tabIndex={open ? 0 : -1}
          className={cn(
            'group/item flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] font-medium text-ui-default',
            'outline-none transition-colors duration-150',
            'hover:bg-ui-fill/70 focus-visible:bg-ui-fill/70',
          )}
          onClick={() => setOpen(false)}
        >
          <GithubMark size={15} className="shrink-0 text-ui-subtle transition-colors group-hover/item:text-ui-default" />
          <span className="min-w-0 flex-1 truncate">GitHub profile</span>
        </a>

        <div className="mx-3 my-1 h-px bg-ui-line" />

        <button
          role="menuitem"
          type="button"
          tabIndex={open ? 0 : -1}
          className={cn(
            'group/item flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] font-medium text-ui-default',
            'outline-none transition-colors duration-150',
            'hover:bg-danger-bg hover:text-danger focus-visible:bg-danger-bg focus-visible:text-danger',
          )}
          onClick={async () => {
            setOpen(false);
            await api.logout();
            location.href = '/login';
          }}
        >
          <LogOut size={15} strokeWidth={2} className="shrink-0 text-ui-subtle transition-colors group-hover/item:text-danger" />
          <span className="min-w-0 flex-1 truncate">Log out</span>
        </button>
      </div>

      {/* Trigger — the account row */}
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${name} account menu`}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'dashboard-sidebar-action',
          'group relative flex w-full items-center gap-3 rounded-md py-3 pl-4 pr-3 text-left',
          'text-ui-default outline-none',
          'transition-colors duration-200 ease-[var(--ease-out-quart)]',
          'hover:bg-ui-fill/50 focus-visible:ring-2 focus-visible:ring-ring',
          open && 'bg-ui-fill/50',
        )}
      >
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover ring-1 ring-ui-line" />
        ) : (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ui-fill text-xs font-semibold text-ui-strong ring-1 ring-ui-line">
            {initial}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold leading-tight text-ui-strong">{name}</span>
          <span className="mt-px block truncate text-[11px] leading-tight text-ui-subtle">@{user.login}</span>
        </span>
        <ChevronsUpDown size={15} strokeWidth={2} className="shrink-0 text-ui-subtle transition-transform duration-200 group-aria-expanded:rotate-180" />
      </button>
    </div>
  );
}

export function AppShell() {
  const { theme, toggleTheme } = useTheme();
  const [sessionUser, setSessionUser] = useState<AuthSessionUser | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.getSession()
      .then(r => { if (!cancelled) setSessionUser(r.user); })
      .catch(() => { if (!cancelled) setSessionUser(null); });
    return () => { cancelled = true; };
  }, []);

  // Auto-hide scrollbars app-wide: every scroll container shows its thumb only
  // while actively scrolling, then fades it back out. Scroll events don't
  // bubble, so we listen in the capture phase at the document level and flag
  // whatever just scrolled with `data-scrolling` (the global CSS keys off it),
  // clearing it ~700ms after scrolling stops.
  useEffect(() => {
    const timers = new WeakMap<Element, number>();
    const onScroll = (e: Event) => {
      let el = e.target as Element | Document | null;
      if (el === document) el = document.scrollingElement;
      if (!(el instanceof Element)) return;
      const node = el;
      node.setAttribute('data-scrolling', 'true');
      const prev = timers.get(node);
      if (prev !== undefined) window.clearTimeout(prev);
      timers.set(node, window.setTimeout(() => node.removeAttribute('data-scrolling'), 700));
    };
    document.addEventListener('scroll', onScroll, true);
    return () => document.removeEventListener('scroll', onScroll, true);
  }, []);

  return (
    <div className="flex h-svh overflow-hidden bg-background">

      {/* Mobile overlay */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-30 bg-background/60 backdrop-blur-md lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* ── SIDEBAR ─────────────────────────────────── */}
      <aside
        className={cn(
          'dashboard-sidebar ui-font-sans',
          'fixed bottom-3 left-3 top-3 z-40 flex flex-col',
          // Mobile drawer: solid card floating over the page.
          'rounded-xl border border-ui-line bg-background text-ui-default',
          'shadow-[0_6px_20px_-8px_oklch(0%_0_0/0.14)]',
          'dark:shadow-[0_8px_24px_-10px_oklch(0%_0_0/0.42)]',
          // Desktop: flat — the sidebar IS the page background; the content card
          // on the right carries the surface instead (Jasper/Mixpanel style).
          'lg:rounded-none lg:border-transparent lg:bg-transparent lg:shadow-none',
          'lg:dark:bg-transparent lg:dark:shadow-none',
          'transition-transform duration-300 ease-[var(--ease-out-expo)]',
          'w-[min(17rem,calc(100vw-1.5rem))]',
          'lg:bottom-4 lg:left-4 lg:top-4',
          'lg:w-[var(--sidebar-width)] lg:translate-x-0',
          'overflow-visible',
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-[calc(100%+1.5rem)]',
        )}
      >

        {/* ── Header ──────────────────────────────── */}
        <div className="relative flex shrink-0 items-center justify-between px-3 pb-3 pt-4">

          {/* Logo */}
          <Link
            to="/dashboard"
            className="flex min-w-0 items-center gap-2.5 rounded-md p-1 -m-1 transition-opacity duration-150 hover:opacity-75 lg:ml-1.5"
            aria-label="Codra dashboard"
            onClick={() => setMobileMenuOpen(false)}
          >
            <img
              src={theme === 'dark' ? codraDark : codraLight}
              alt="Codra"
              className="h-7 w-auto rounded-md"
            />
          </Link>

          {/* Controls: theme toggle (all sizes) + close (mobile) */}
          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={toggleTheme}
              className="flex h-9 w-9 items-center justify-center rounded-md border border-ui-line bg-ui-base text-ui-default transition-colors hover:bg-ui-fill"
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
            </button>
            <button
              onClick={() => setMobileMenuOpen(false)}
              className="flex h-9 w-9 items-center justify-center rounded-md border border-ui-line bg-ui-base text-ui-default transition-colors hover:bg-ui-fill lg:hidden"
              aria-label="Close menu"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Divider */}
        <div className="mx-3 h-px bg-ui-line" />

        {/* ── Nav ─────────────────────────────────── */}
        <nav className="flex-1 overflow-visible px-2 py-3">
          <p className="mb-1.5 px-4 text-[10px] font-semibold uppercase tracking-[0.14em] text-ui-subtle">
            Menu
          </p>

          {/* SharedLayoutBg provides the animated hover pill. Uses SidebarNavItem
             (hook-based active state) instead of NavLink render props —
             cloneElement can't wrap a render function as children. */}
          <SharedLayoutBg
            className="gap-1"
            pillClassName="rounded-md bg-ui-fill/50"
          >
            {links.map(({ to, label, end, icon }) => (
              /* Plain div is the direct child SharedLayoutBg clones — it injects
                 the pill + z-10 wrapper into a real DOM element. */
              <div key={to}>
                <SidebarNavItem
                  to={to}
                  end={end}
                  label={label}
                  icon={icon}
                  onClick={() => setMobileMenuOpen(false)}
                />
              </div>
            ))}
          </SharedLayoutBg>
        </nav>

        {/* Divider */}
        <div className="mx-3 h-px bg-ui-line" />

        {/* ── Footer ──────────────────────────────── */}
        <div className="shrink-0 space-y-1 p-2 pt-3">

          {/* GitHub star — quiet row, same treatment as nav items */}
          <a
            href="https://github.com/devarshishimpi/codra"
            target="_blank"
            rel="noopener noreferrer"
            title="Star on GitHub"
            className={cn(
              'dashboard-sidebar-action',
              'group relative flex h-10 w-full items-center gap-3 rounded-md pl-4 pr-3.5',
              'text-[13px] font-medium text-ui-default hover:text-ui-strong dark:text-ui-subtle dark:hover:text-ui-default',
              'transition-colors duration-200 ease-[var(--ease-out-quart)]',
              'hover:bg-ui-fill/50',
            )}
          >
            <Star size={15} strokeWidth={2} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">Star on GitHub</span>
          </a>

          {/* Account */}
          {sessionUser && <AccountMenu user={sessionUser} />}
        </div>

        <div className="h-1 shrink-0" />
      </aside>

      {/* ── MAIN — the content card. The shell is fixed-height and never scrolls;
          the card fills the viewport and hands scrolling to the page inside
          (the jobs table scrolls its own body, so the card stays put). ── */}
      <main
        className={cn(
          'app-shell-content',
          'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
          'transition-[margin,color,background-color] duration-300 ease-[var(--ease-out-expo)]',
          'lg:ml-[calc(var(--sidebar-width)+2rem)]',
          'lg:my-4 lg:mr-4 lg:rounded-xl lg:border lg:border-ui-line lg:bg-background',
          'lg:shadow-[0_1px_2px_oklch(0%_0_0/0.04)]',
          'lg:dark:border-[oklch(0.24_0_0)] lg:dark:shadow-none',
        )}
      >

        {/* Mobile topbar */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4 lg:hidden">
          <button
            className="-ml-2 rounded-md p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            onClick={() => setMobileMenuOpen(true)}
            aria-label="Open menu"
          >
            <AlignLeft size={20} />
          </button>
          <button
            onClick={toggleTheme}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
          </button>
        </header>

        {/* Scroll region: full-width so its (auto-hiding) scrollbar sits at the
            card's inner edge. Pages that fill the height (jobs) scroll their own
            body and leave this untouched; shorter pages that overflow fall back
            to scrolling here — always inside the card, never the window. The
            inner wrapper centres content to the max width. */}
        <div className="auto-hide-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="mx-auto flex h-full w-full max-w-screen-2xl flex-col px-4 py-6 md:px-6 md:py-8 lg:px-8">
            <Outlet />
          </div>
        </div>
      </main>
    </div>
  );
}
