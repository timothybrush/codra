import { NavLink, Outlet, Link, useMatch, useResolvedPath } from 'react-router-dom';
import { useEffect, useState, type CSSProperties, type ComponentType } from 'react';
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
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { cn } from '@client/lib/utils';
import { useTheme } from '@client/lib/theme';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@client/components/ui/dropdown-menu';
import codraDark from '@/assets/codra-fullicon-dark.svg';
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
 * plain JSX children rather than a function.
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
        'group flex h-[2.375rem] w-full items-center gap-3 rounded-lg px-3 text-sm font-medium',
        'outline-none transition-[color,box-shadow] duration-200 ease-[var(--ease-out-quart)]',
        'focus-visible:ring-2 focus-visible:ring-ring',
        isActive ? 'bg-[oklch(79%_0.23_115/0.23)]' : '',
      )}
    >
      {/* Active left bar */}
      <span
        className={cn(
          'absolute -left-2 top-1/2 -translate-y-1/2 w-[3px] rounded-r-full bg-[oklch(79%_0.23_115)]',
          'z-20 transition-[height,opacity] duration-200',
          isActive ? 'h-5 opacity-100' : 'h-0 opacity-0',
        )}
      />

      {/* Active shine — white beam reads on both white & black sidebar */}
      {isActive && (
        <span
          className="pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-lg"
          aria-hidden="true"
        >
          <span className="dashboard-sidebar-shine absolute inset-0 flex h-full w-full justify-center">
            <span className="relative h-full w-8 bg-[oklch(79%_0.23_115/0.45)]" />
          </span>
        </span>
      )}

      {/* Icon */}
      <span
        className={cn(
          'dashboard-sidebar-action-icon',
          'relative z-10 flex h-[1.75rem] w-[1.75rem] shrink-0 items-center justify-center rounded-md',
          'transition-colors duration-200',
        )}
      >
        <Icon size={15} strokeWidth={isActive ? 2.6 : 2.15} />
      </span>

      {/* Label */}
      <span className="dashboard-sidebar-action-label relative z-10 min-w-0 flex-1 truncate">
        {label}
      </span>
    </NavLink>
  );
}

const collapsedTooltipClass = [
  'lg:pointer-events-none lg:absolute lg:left-[calc(100%+1rem)]',
  'lg:z-50 lg:w-max lg:max-w-44 lg:rounded-lg',
  'lg:border lg:border-border lg:bg-white lg:dark:bg-popover',
  'lg:px-3 lg:py-1.5 lg:text-xs lg:font-semibold lg:text-black lg:dark:text-white',
  'lg:shadow-lg lg:opacity-0 lg:translate-x-1',
  'lg:transition-[opacity,transform] lg:duration-150',
  'lg:group-hover:opacity-100 lg:group-hover:translate-x-0',
  'lg:group-focus-visible:opacity-100 lg:group-focus-visible:translate-x-0',
];

/**
 * Collapsed (icon-only) sidebar nav item.
 * Same fixed oklch color tokens as SidebarNavItem — no dark: variants.
 */
function CollapsedNavItem({
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
        'group relative flex h-[2.375rem] w-[2.375rem] items-center justify-center rounded-lg',
        'outline-none transition-[color,box-shadow] duration-200 ease-[var(--ease-out-quart)]',
        'focus-visible:ring-2 focus-visible:ring-ring',
        isActive ? 'bg-[oklch(79%_0.23_115/0.23)]' : '',
      )}
    >
      {/* Active left bar */}
      <span
        className={cn(
          'absolute -left-2 top-1/2 -translate-y-1/2 w-[3px] rounded-r-full bg-[oklch(79%_0.23_115)]',
          'z-20 transition-[height,opacity] duration-200',
          isActive ? 'h-5 opacity-100' : 'h-0 opacity-0',
        )}
      />

      {/* Active shine — lime beam */}
      {isActive && (
        <span
          className="pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-lg"
          aria-hidden="true"
        >
          <span className="dashboard-sidebar-shine absolute inset-0 flex h-full w-full justify-center">
            <span className="relative h-full w-8 bg-[oklch(79%_0.23_115/0.45)]" />
          </span>
        </span>
      )}

      {/* Icon */}
      <span
        className={cn(
          'dashboard-sidebar-action-icon',
          'relative z-10 flex h-[1.875rem] w-[1.875rem] shrink-0 items-center justify-center rounded-md',
          'transition-[color,transform] duration-200 ease-[var(--ease-out-quart)]',
        )}
      >
        <Icon size={15} strokeWidth={isActive ? 2.6 : 2.15} />
      </span>

      {/* Hover tooltip */}
      <span className={cn('dashboard-sidebar-action-label dashboard-sidebar-tooltip', collapsedTooltipClass)}>
        {label}
      </span>
    </NavLink>
  );
}

function getStoredSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem('codra-sidebar-collapsed') === 'true';
  } catch {
    return false;
  }
}

function getIsDesktop(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(min-width: 1024px)').matches;
}

export function AppShell() {
  const { theme, toggleTheme } = useTheme();
  const [sessionUser, setSessionUser] = useState<AuthSessionUser | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => getStoredSidebarCollapsed());
  const [isDesktop, setIsDesktop] = useState<boolean>(() => getIsDesktop());

  const shellStyle = {
    '--app-sidebar-width': sidebarCollapsed
      ? 'var(--sidebar-collapsed-width)'
      : 'var(--sidebar-width)',
  } as CSSProperties;
  const githubProfileHref = sessionUser ? `https://github.com/${sessionUser.login}` : 'https://github.com';
  const accountName = sessionUser?.name?.trim() || sessionUser?.login || 'GitHub';
  const accountInitial = accountName.charAt(0).toUpperCase();
  const accountMenuBesideSidebar = sidebarCollapsed && isDesktop;

  useEffect(() => {
    let cancelled = false;
    api.getSession()
      .then(r => { if (!cancelled) setSessionUser(r.user); })
      .catch(() => { if (!cancelled) setSessionUser(null); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('codra-sidebar-collapsed', String(sidebarCollapsed));
    } catch {
      // ignore storage failures
    }
  }, [sidebarCollapsed]);

  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)');
    const updateIsDesktop = () => setIsDesktop(query.matches);
    updateIsDesktop();
    query.addEventListener('change', updateIsDesktop);
    return () => query.removeEventListener('change', updateIsDesktop);
  }, []);

  return (
    <div className="flex min-h-svh bg-background" style={shellStyle}>

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
          'dashboard-sidebar',
          sidebarCollapsed && 'dashboard-sidebar-collapsed',
          'fixed bottom-3 left-3 top-3 z-40 flex flex-col',
          'rounded-xl border border-border/60',
          'bg-white dark:bg-black',
          'text-black dark:text-white',
          'shadow-[0_6px_20px_-8px_oklch(0%_0_0/0.14),0_0_0_1px_color-mix(in_oklch,var(--primary)_6%,transparent)]',
          'dark:shadow-[0_8px_24px_-10px_oklch(0%_0_0/0.42),0_0_0_1px_color-mix(in_oklch,var(--primary)_9%,transparent)]',
          'transition-[transform,width] duration-300 ease-[var(--ease-out-expo)]',
          'w-[min(17rem,calc(100vw-1.5rem))]',
          'lg:bottom-4 lg:left-4 lg:top-4',
          'lg:w-[var(--app-sidebar-width)] lg:translate-x-0',
          'overflow-visible',
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-[calc(100%+1.5rem)]',
        )}
      >

        {/* ── Header ──────────────────────────────── */}
        <div className={cn(
          'relative flex shrink-0 items-center px-3 pt-4 pb-3',
          'justify-between',
          sidebarCollapsed && 'lg:flex-col lg:items-center lg:justify-start lg:gap-2 lg:pb-4',
        )}>

          {/* Logo */}
          <Link
            to="/dashboard"
            className={cn(
              'flex min-w-0 items-center gap-2.5 rounded-lg p-1 -m-1',
              'transition-opacity duration-150 hover:opacity-75',
              !sidebarCollapsed && 'lg:ml-1.5',
              sidebarCollapsed && 'lg:justify-center',
            )}
            aria-label="Codra dashboard"
            onClick={() => setMobileMenuOpen(false)}
          >
            <img
              src="/icons/codra-icon-dark.svg"
              alt=""
              className={cn(
                'hidden h-8 w-8 shrink-0 rounded-lg lg:block',
                !sidebarCollapsed && 'lg:hidden',
              )}
            />
            <img
              src={codraDark}
              alt="Codra"
              className={cn('h-6 w-auto', sidebarCollapsed && 'lg:hidden')}
            />
          </Link>

          {/* Expand button (collapsed desktop) */}
          <button
            onClick={() => setSidebarCollapsed(false)}
            className={cn(
              'hidden h-8 w-8 items-center justify-center rounded-full',
              'bg-white text-black shadow-sm dark:bg-white/10 dark:text-white',
              'transition-[background-color,color,transform] duration-200 hover:-translate-y-px hover:bg-[color-mix(in_oklch,var(--primary)_12%,white)] dark:hover:bg-white/15',
              sidebarCollapsed && 'lg:flex',
            )}
            aria-label="Expand sidebar"
          >
            <ChevronRight size={15} strokeWidth={2.25} />
          </button>

          {/* Collapse / theme / close controls (expanded) */}
          <div className={cn('ml-auto flex items-center gap-1 lg:ml-0', sidebarCollapsed && 'lg:hidden')}>
            <button
              onClick={() => setSidebarCollapsed(true)}
              className="hidden h-8 w-8 items-center justify-center rounded-full bg-white text-black shadow-sm transition-[background-color,color,transform] duration-200 hover:-translate-y-px hover:bg-[color-mix(in_oklch,var(--primary)_12%,white)] dark:bg-white/10 dark:text-white dark:hover:bg-white/15 lg:flex"
              aria-label="Collapse sidebar"
            >
              <ChevronLeft size={15} strokeWidth={2.25} />
            </button>
            <button
              onClick={toggleTheme}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-black shadow-sm transition-[background-color,color,transform] duration-200 hover:-translate-y-px hover:bg-[color-mix(in_oklch,var(--primary)_12%,white)] dark:bg-white/10 dark:text-white dark:hover:bg-white/15 lg:h-8 lg:w-8"
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
            </button>
            <button
              onClick={() => setMobileMenuOpen(false)}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-black shadow-sm transition-colors hover:bg-secondary dark:bg-white/10 dark:text-white lg:hidden"
              aria-label="Close menu"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Divider */}
        <div className="dashboard-sidebar-divider" />

        {/* ── Nav ─────────────────────────────────── */}
        <nav className="flex-1 overflow-visible px-2 py-3">
          {!sidebarCollapsed && (
            <p className="mb-2 px-2 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-black dark:text-white">
              Menu
            </p>
          )}

          {/* Collapsed: plain icon buttons stacked */}
          {sidebarCollapsed ? (
            <SharedLayoutBg
              className="gap-2 lg:items-center"
              pillClassName="bg-[oklch(60%_0.006_286/0.45)]"
            >
              {links.map(({ to, label, end, icon }) => (
                <div key={to}>
                  <CollapsedNavItem
                    to={to}
                    end={end}
                    label={label}
                    icon={icon}
                    onClick={() => setMobileMenuOpen(false)}
                  />
                </div>
              ))}
            </SharedLayoutBg>
          ) : (
            /* Expanded: SharedLayoutBg provides the animated hover pill.
               Uses SidebarNavItem (hook-based active state) instead of NavLink
               render props — cloneElement can't wrap a render function as children. */
            <SharedLayoutBg
              className="gap-2"
              pillClassName="bg-[oklch(60%_0.006_286/0.30)]"
            >
              {links.map(({ to, label, end, icon }) => (
                /* Plain div is the direct child SharedLayoutBg clones — it injects
                   the pill + z-10 wrapper into a real DOM element. SidebarNavItem
                   (a custom component) ignores injected children so can't be the
                   direct child. */
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
          )}
        </nav>

        {/* Divider */}
        <div className="dashboard-sidebar-divider" />

        {/* ── Footer ──────────────────────────────── */}
        <div className={cn('shrink-0 space-y-2 p-2 pt-3', sidebarCollapsed && 'lg:flex lg:flex-col lg:items-center')}>

          {/* GitHub star */}
          <a
            href="https://github.com/devarshishimpi/codra"
            target="_blank"
            rel="noopener noreferrer"
            title="Star on GitHub"
              className={cn(
                'dashboard-sidebar-action',
                'group relative flex h-[2.375rem] w-full items-center justify-center gap-2 rounded-lg px-3',
                'bg-transparent',
                'text-xs font-bold text-black dark:text-white',
                'transition-[background-color,border-color,color,box-shadow,transform] duration-200 ease-[var(--ease-out-quart)]',
              'hover:border-primary/35 hover:bg-secondary/70 hover:text-black hover:shadow-[0_10px_20px_-18px_var(--primary)] active:translate-y-0 dark:hover:text-white',
              sidebarCollapsed && 'lg:w-[2.375rem] lg:justify-center lg:px-0',
            )}
          >
            <Star
              size={14}
              strokeWidth={2.35}
              className="dashboard-sidebar-action-icon shrink-0 text-black transition-[color,transform] duration-200 ease-[var(--ease-out-quart)] group-hover:scale-110 dark:text-white"
            />
            <span className={cn('dashboard-sidebar-action-label transition-transform duration-200 ease-[var(--ease-out-quart)]', sidebarCollapsed && 'lg:hidden')}>
              Star on GitHub
            </span>
          </a>

          {/* Account */}
          {sessionUser && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  title={`${accountName} account menu`}
                  className={cn(
                    'dashboard-sidebar-action',
                    'group relative flex w-full items-center gap-3 rounded-md p-2 text-left',
                    'bg-transparent',
                    'text-black dark:text-white',
                    'transition-[background-color,border-color,box-shadow,transform] duration-200 ease-[var(--ease-out-quart)]',
                    'hover:border-primary/35 hover:bg-secondary/75 hover:shadow-[0_10px_22px_-18px_var(--primary)]',
                    sidebarCollapsed && 'lg:h-8 lg:w-8 lg:justify-center lg:rounded-md lg:border-dashed lg:p-0',
                  )}
                >
                  <span className="relative shrink-0">
                    {sessionUser.avatarUrl ? (
                      <img
                        src={sessionUser.avatarUrl}
                        alt=""
                        className={cn(
                          'h-9 w-9 rounded-full object-cover ring-1 ring-border/70 transition-transform duration-200 ease-[var(--ease-out-quart)] group-hover:scale-105 lg:group-hover:scale-110',
                          sidebarCollapsed && 'lg:h-7 lg:w-7',
                        )}
                      />
                    ) : (
                      <span className={cn(
                        'flex h-9 w-9 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground ring-1 ring-border/70 transition-transform duration-200 ease-[var(--ease-out-quart)] group-hover:scale-105 lg:group-hover:scale-110',
                        sidebarCollapsed && 'lg:h-7 lg:w-7 lg:text-xs',
                      )}>
                        {accountInitial}
                      </span>
                    )}
                  </span>
                  <span className={cn('dashboard-sidebar-action-label min-w-0 flex-1', sidebarCollapsed && 'lg:hidden')}>
                    <span className="block truncate text-[13px] font-bold leading-tight text-black dark:text-white">
                      {accountName}
                    </span>
                    <span className="dashboard-sidebar-username mt-0.5 block truncate text-[11px] font-semibold leading-tight text-zinc-200">
                      @{sessionUser.login}
                    </span>
                  </span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side={accountMenuBesideSidebar ? 'right' : 'top'}
                align={accountMenuBesideSidebar ? 'end' : 'start'}
                sideOffset={accountMenuBesideSidebar ? 16 : 12}
                alignOffset={accountMenuBesideSidebar ? -2 : 0}
                className="w-60"
              >
                <div className="mb-1 flex min-w-0 items-center gap-3 rounded-md px-2 py-2">
                  {sessionUser.avatarUrl ? (
                    <img
                      src={sessionUser.avatarUrl}
                      alt=""
                      className="h-9 w-9 rounded-full object-cover ring-1 ring-border"
                    />
                  ) : (
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground ring-1 ring-border">
                      {accountInitial}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold leading-tight text-popover-foreground">
                      {accountName}
                    </p>
                    <p className="mt-0.5 truncate text-xs font-semibold text-muted-foreground">
                      @{sessionUser.login}
                    </p>
                  </div>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild className="cursor-pointer font-semibold">
                  <a href={githubProfileHref} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between gap-3">
                    <span>GitHub profile</span>
                    <ChevronRight size={13} strokeWidth={2.35} className="opacity-60" />
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="cursor-pointer gap-2 font-semibold"
                  onClick={async () => {
                    await api.logout();
                    location.href = '/login';
                  }}
                >
                  <LogOut size={13} strokeWidth={2.35} />
                  Logout
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <div className="h-1 shrink-0" />
      </aside>

      {/* ── MAIN ────────────────────────────────────── */}
      <main className="flex min-w-0 flex-1 flex-col transition-[margin,color,background-color] duration-300 ease-[var(--ease-out-expo)] lg:ml-[calc(var(--app-sidebar-width)+2rem)]">

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

        <div className="app-shell-content mx-auto w-full max-w-screen-xl px-4 py-6 md:px-8 md:py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
