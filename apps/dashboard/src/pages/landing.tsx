import { Button, GithubMark, LinkButton } from '@codraoss/ui';
import { Sun, Moon, ExternalLink } from 'lucide-react';
import { useTheme } from '@codraoss/ui/theme';
import codraDark from '@/assets/codra-fullicon-dark.svg';
import codraLight from '@/assets/codra-fullicon-light.svg';

const FEATURES = [
  {
    title: 'Understands your codebase',
    desc: 'Reviews diffs with full context from the surrounding code, not just the changed lines.',
  },
  {
    title: 'Flags real issues',
    desc: 'Security vulnerabilities, logic errors, and pattern violations - surfaced before merge.',
  },
  {
    title: 'Configurable per repo',
    desc: 'Set review depth, model chain, and strictness from the dashboard. No config files.',
  },
];

/** Faint dotted-grid texture, faded out toward the bottom - the "control panel" backdrop. */
const dotGrid = {
  backgroundImage:
    'radial-gradient(circle, color-mix(in oklch, var(--ui-line) 75%, transparent) 1px, transparent 1px)',
  backgroundSize: '22px 22px',
  maskImage: 'radial-gradient(ellipse 90% 80% at 30% 0%, black, transparent 80%)',
  WebkitMaskImage: 'radial-gradient(ellipse 90% 80% at 30% 0%, black, transparent 80%)',
};

function DotGrid() {
  return <div aria-hidden className="pointer-events-none absolute inset-0" style={dotGrid} />;
}

export function LandingPage() {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="flex min-h-svh flex-col bg-ui-canvas text-ui-default">

      <header className="sticky top-0 z-40 border-b border-ui-line bg-ui-base">
        <div className="flex h-14 w-full items-center justify-between px-4 sm:px-6 lg:px-8">
          <img
            src={theme === 'dark' ? codraDark : codraLight}
            className="h-6 w-auto sm:h-7"
            alt="Codra"
          />
          <div className="flex items-center gap-2 sm:gap-3">
            <LinkButton
              variant="secondary"
              size="sm"
              shape="square"
              href="https://github.com/devarshishimpi/codra"
              external
              aria-label="Codra on GitHub"
              className="hidden sm:flex"
            >
              <GithubMark size={14} />
            </LinkButton>
            <Button
              variant="secondary"
              size="sm"
              shape="square"
              onClick={toggleTheme}
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
            </Button>
            <LinkButton
              variant="primary"
              size="sm"
              href="/auth/github"
            >
              Sign in
            </LinkButton>
          </div>
        </div>
      </header>

      <main className="grid flex-1 grid-cols-1 lg:grid-cols-[1fr_440px]">

        <div className="relative flex flex-col justify-between overflow-hidden border-b border-ui-line bg-ui-base px-8 py-14 sm:px-14 sm:py-20 lg:border-b-0 lg:border-r">
          <DotGrid />

          <div className="relative max-w-xl space-y-8">
            <h1 className="font-display text-[2.75rem] font-semibold leading-[1.04] tracking-tight text-ui-strong sm:text-6xl">
              AI code review<br />
              on every PR.
            </h1>

            <p className="max-w-md text-[0.95rem] leading-relaxed text-ui-subtle">
              Codra reviews pull requests automatically, checking for bugs,
              security issues, and code patterns specific to your repository.
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <LinkButton
                variant="primary"
                size="base"
                href="/auth/github"
                icon={<GithubMark size={15} />}
                className="!rounded-sm"
              >
                Get started with GitHub
              </LinkButton>
              <LinkButton
                variant="secondary"
                size="base"
                href="https://github.com/devarshishimpi/codra#readme"
                external
                className="!rounded-sm"
              >
                Read the docs
              </LinkButton>
            </div>
          </div>

          <div className="relative mt-16 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-ui-line pt-8 font-mono text-[0.7rem] uppercase tracking-[0.12em] text-ui-subtle">
            <a
              href="https://codra.run"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 transition-colors hover:text-ui-brand"
            >
              <ExternalLink size={11} />
              codra.run
            </a>
            <span className="text-ui-line">/</span>
            <a
              href="https://github.com/devarshishimpi/codra"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 transition-colors hover:text-ui-brand"
            >
              <ExternalLink size={11} />
              GitHub
            </a>
          </div>
        </div>

        <div className="relative flex flex-col justify-center gap-5 overflow-hidden border-t border-ui-line bg-ui-canvas px-8 py-14 sm:px-12 sm:py-20 lg:border-t-0">
          <DotGrid />

          <div className="relative flex items-center gap-3">
            <span className="font-mono text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-ui-subtle">
              What it does
            </span>
            <span className="h-px flex-1 bg-ui-line" />
          </div>

          <div className="relative flex flex-col gap-3">
            {FEATURES.map((item, i) => (
              <div
                key={item.title}
                className="group relative overflow-hidden rounded-xl border border-ui-line bg-ui-base p-4 transition-colors duration-200 hover:border-ui-brand/40"
              >
                <span className="absolute inset-y-0 left-0 w-[2px] scale-y-95 bg-ui-brand opacity-0 transition-[transform,opacity] duration-200 group-hover:scale-y-100 group-hover:opacity-100" />

                <div className="flex items-center gap-3">
                  <span className="font-mono text-[0.72rem] font-semibold tabular-nums text-ui-brand">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <h3 className="text-sm font-semibold text-ui-strong">{item.title}</h3>
                </div>

                <p className="mt-2 pl-[calc(0.72rem+0.75rem)] text-[0.82rem] leading-relaxed text-ui-subtle">
                  {item.desc}
                </p>
              </div>
            ))}
          </div>
        </div>

      </main>
    </div>
  );
}
