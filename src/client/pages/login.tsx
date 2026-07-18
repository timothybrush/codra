import { useMemo } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Sun, Moon, ShieldCheck, ArrowLeft, AlertCircle } from 'lucide-react';
import { useTheme } from '@client/lib/theme';
import { GithubMark } from '@client/components/shared/github-mark';
import codraDark from '@/assets/codra-fullicon-dark.svg';
import codraLight from '@/assets/codra-fullicon-light.svg';

function getErrorMessage(error: string | null) {
  switch (error) {
    case 'not_allowed':
      return 'This GitHub account is not allowed to access the Codra dashboard.';
    case 'access_denied':
      return 'GitHub sign-in was cancelled before authorization completed.';
    case 'invalid_state':
      return 'Your sign-in session expired. Please try signing in with GitHub again.';
    case 'invalid_callback':
      return 'GitHub did not return a valid callback. Please try again.';
    case 'oauth_failed':
      return 'GitHub sign-in failed while completing the OAuth flow.';
    default:
      return null;
  }
}

export function LoginPage() {
  const { theme, toggleTheme } = useTheme();
  const [searchParams] = useSearchParams();
  const error = useMemo(() => getErrorMessage(searchParams.get('error')), [searchParams]);

  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center bg-background px-4 py-8">

      {/* Top bar: back link + theme toggle */}
      <Link
        to="/"
        className="fixed left-4 top-4 z-50 flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3.5 text-xs font-semibold text-foreground shadow-sm transition-colors hover:bg-secondary dark:border-white/10 dark:bg-white/[0.06] dark:shadow-[0_1px_2px_oklch(0%_0_0/0.4),inset_0_1px_0_oklch(100%_0_0/0.06)] dark:hover:bg-white/[0.1] sm:left-6 sm:top-6"
      >
        <ArrowLeft size={13} />
        Home
      </Link>
      <button
        onClick={toggleTheme}
        className="fixed right-4 top-4 z-50 flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card text-foreground shadow-sm transition-colors hover:bg-secondary dark:border-white/10 dark:bg-white/[0.06] dark:shadow-[0_1px_2px_oklch(0%_0_0/0.4),inset_0_1px_0_oklch(100%_0_0/0.06)] dark:hover:bg-white/[0.1] sm:right-6 sm:top-6"
        aria-label="Toggle theme"
      >
        {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
      </button>

      <div className="page-enter flex w-full max-w-md flex-col items-center">

        {/* Card */}
        <div className="surface surface-static-shadow relative w-full overflow-hidden">
          {/* Dot-grid texture */}
          <span className="chart-card-inner" aria-hidden="true" />
          {/* Lime top accent */}
          <span
            className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-transparent via-primary/70 to-transparent"
            aria-hidden="true"
          />

          <div className="relative flex flex-col items-center gap-7 px-6 py-10 sm:px-12 sm:py-12">

            {/* Logo */}
            <img
              src={theme === 'dark' ? codraDark : codraLight}
              alt="Codra"
              className="h-10 w-auto sm:h-11"
            />

            {/* Heading + sub */}
            <div className="space-y-2 text-center">
              <h1 className="text-xl font-bold tracking-tight text-foreground">
                Welcome back
              </h1>
              <p className="mx-auto max-w-xs text-sm leading-relaxed text-muted-foreground">
                Sign in with your approved GitHub account to access the PR review dashboard.
              </p>
            </div>

            {/* Error */}
            {error && (
              <div className="animate-slide-down flex w-full items-start gap-2.5 rounded-lg border border-danger-border bg-danger-bg px-4 py-3 text-left text-sm text-danger">
                <AlertCircle size={15} className="mt-0.5 shrink-0" />
                {error}
              </div>
            )}

            {/* CTA */}
            <a
              href="/auth/github"
              id="login-submit"
              className="inline-flex h-12 w-full items-center justify-center gap-2.5 rounded-md border border-[var(--btn-primary-border)] bg-[var(--btn-primary-surface)] text-[0.95rem] font-semibold text-[var(--btn-primary-fg)] transition-all hover:bg-[var(--btn-primary-hover)] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <GithubMark size={17} />
              Sign in with GitHub
            </a>
          </div>
        </div>

        {/* Footer note — outside the card */}
        <div className="mt-6 flex items-center gap-2.5 px-2 text-muted-foreground">
          <ShieldCheck size={16} className="shrink-0 text-success" />
          <p className="text-xs leading-snug">
            Only authorized GitHub users can access this instance.
          </p>
        </div>
      </div>
    </div>
  );
}
