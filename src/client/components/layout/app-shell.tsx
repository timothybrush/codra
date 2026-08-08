import { Outlet, Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { SharedLayoutBg } from '@client/components/motion/shared-layout-bg';
import { api } from '@client/lib/api';
import { LayoutDashboard, AlignLeft, GitBranch, BarChart2, Sun, Moon, Activity, Settings, Star, X, ArrowUpRight } from 'lucide-react';
import { cn } from '@client/lib/utils';
import { useTheme } from '@client/lib/theme';
import codraDark from '@/assets/codra-fullicon-dark.svg';
import codraLight from '@/assets/codra-fullicon-light.svg';
import type { AuthSessionUser } from '@shared/api';

import { SidebarNavItem } from '@client/components/layout/sidebar-nav-item';
import { AccountMenu } from '@client/components/layout/account-menu';
const links = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/jobs', label: 'Jobs', icon: Activity, end: false },
  { to: '/repos', label: 'Repos', icon: GitBranch, end: false },
  { to: '/stats', label: 'Stats', icon: BarChart2, end: false },
  { to: '/settings', label: 'Settings', icon: Settings, end: false },
];


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
          // Desktop: flat - the sidebar IS the page background; the content card
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

        {/* ── Header ──────────────────────────────────
            `pl-4` puts the logo on the same optical left edge as the nav rows,
            the section label and the account block below — the rail reads as one
            column instead of a logo floating off-axis. */}
        <div className="relative flex shrink-0 items-center justify-between px-2 py-4">

          {/* Logo — `pl-4` inside the shared `px-2` container reproduces the exact
              inset of a nav row's label, so the wordmark and the menu share one
              optical left edge (they were 8px apart). */}
          <Link
            to="/dashboard"
            className="flex min-w-0 items-center rounded-md pl-4 transition-opacity duration-150 hover:opacity-75"
            aria-label="Codra dashboard"
            onClick={() => setMobileMenuOpen(false)}
          >
            <img
              src={theme === 'dark' ? codraDark : codraLight}
              alt="Codra"
              className="h-7 w-auto rounded-md"
            />
          </Link>

          {/* Controls: theme toggle (all sizes) + close (mobile). Ghost, not boxed
              — a bordered control here reads as a heavy chip on a flat rail, while
              the rest of the app uses quiet ghost buttons for this weight. */}
          <div className="ml-auto flex items-center gap-0.5">
            <button
              onClick={toggleTheme}
              className="flex h-8 w-8 items-center justify-center rounded-md text-ui-subtle transition-colors hover:bg-ui-fill/60 hover:text-ui-strong"
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
            </button>
            <button
              onClick={() => setMobileMenuOpen(false)}
              className="flex h-8 w-8 items-center justify-center rounded-md text-ui-subtle transition-colors hover:bg-ui-fill/60 hover:text-ui-strong lg:hidden"
              aria-label="Close menu"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* ── Nav ─────────────────────────────────── */}
        <nav className="flex-1 overflow-visible px-2 pb-3">
          <p className="mb-1.5 px-4 text-[10px] font-semibold uppercase tracking-[0.14em] text-ui-subtle dark:text-ui-subtle/65">
            Menu
          </p>

          {/* SharedLayoutBg provides the animated hover pill. Uses SidebarNavItem
             (hook-based active state) instead of NavLink render props -
             cloneElement can't wrap a render function as children. */}
          <SharedLayoutBg
            className="gap-1"
            pillClassName="rounded-md bg-ui-fill/50"
          >
            {links.map(({ to, label, end, icon }) => (
              /* Plain div is the direct child SharedLayoutBg clones - it injects
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

        {/* ── Footer ──────────────────────────────────
            One inset rule separates navigation from account/meta. The header
            divider is gone: spacing already groups it, and free-floating hairlines
            on a transparent rail read as stray marks next to the card-bordered
            surfaces everywhere else. */}
        <div className="mx-4 h-px shrink-0 bg-ui-line" />

        <div className="shrink-0 space-y-0.5 p-2 pt-2">

          {/* GitHub star — tertiary, so it sits a step quieter than navigation and
              gains an external-link cue on hover. */}
          <a
            href="https://github.com/devarshishimpi/codra"
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              'dashboard-sidebar-action',
              'group relative flex h-9 w-full items-center gap-3 rounded-md pl-4 pr-3.5',
              'text-[13px] text-ui-subtle hover:text-ui-strong',
              'dark:text-ui-subtle/65 dark:hover:text-ui-default',
              'transition-colors duration-200 ease-[var(--ease-out-quart)]',
              'hover:bg-ui-fill/50',
            )}
          >
            <Star size={15} strokeWidth={2} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">Star on GitHub</span>
            <ArrowUpRight
              size={13}
              className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
            />
          </a>

          {/* Account */}
          {sessionUser && <AccountMenu user={sessionUser} />}
        </div>
      </aside>

      {/* ── MAIN - the content card. The shell is fixed-height and never scrolls;
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

        {/* Mobile topbar - same ui-* tokens and control sizing as the sidebar
            header, so the two read as one system when the drawer is open. */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-ui-line px-4 lg:hidden">
          <button
            className="-ml-2 rounded-md p-2 text-ui-default transition-colors hover:bg-ui-fill hover:text-ui-strong"
            onClick={() => setMobileMenuOpen(true)}
            aria-label="Open menu"
          >
            <AlignLeft size={20} />
          </button>
          <button
            onClick={toggleTheme}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-ui-line bg-ui-base text-ui-default transition-colors hover:bg-ui-fill"
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </header>

        {/* Scroll region: full-width so its (auto-hiding) scrollbar sits at the
            card's inner edge. Pages that fill the height (jobs) scroll their own
            body and leave this untouched; shorter pages that overflow fall back
            to scrolling here - always inside the card, never the window. The
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
