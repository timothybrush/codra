import type { ComponentPropsWithoutRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { FileText } from 'lucide-react';
import { cn } from '@client/lib/utils';
import type { ParsedReviewComment } from '@shared/schema';
import { severityConfig } from './constants';

const safeRehypePlugins = [rehypeRaw, rehypeSanitize];

/** Plain-English reason a finding never reached the pull request. */
const DISPOSITION_LABEL: Record<string, string> = {
  severity: 'Below the severity threshold for this repository',
  confidence: 'The model was not confident enough in this finding',
  suppression: 'Already reported on an earlier commit, or previously dismissed',
  dedupe: 'Collapsed into another finding with the same title',
  verify: 'The verification pass could not confirm it against the diff',
  cap: 'Over the max-comments limit for a single review',
  unverifiable_passthrough: 'Could not be verified — no diff context was available',
};

interface CommentCardProps {
  comment: ParsedReviewComment;
  filePath: string;
}

export function CommentCard({ comment, filePath }: CommentCardProps) {
  const sev = severityConfig[comment.severity] ?? severityConfig.nit;
  const SevIcon = sev.icon;

  // Plain code rendering (no syntax highlighting) -- findings read better as
  // quiet monospace blocks against the tinted severity card.
  const markdownComponents = {
    code({ className, children, ...props }: ComponentPropsWithoutRef<'code'> & { className?: string }) {
      const text = String(children ?? '');
      const isBlock = /language-[\w+-]+/.test(className ?? '') || text.includes('\n');
      if (!isBlock) {
        return (
          <code className="ui-font-mono rounded border border-ui-line bg-ui-fill/60 px-1 py-0.5 text-[0.85em] text-ui-strong" {...props}>
            {children}
          </code>
        );
      }
      return (
        <code className="ui-font-mono block whitespace-pre text-[12px] leading-relaxed" {...props}>
          {text.replace(/\n+$/, '')}
        </code>
      );
    },
  } as const;

  return (
    <article className="ui-font-sans rounded-md border border-ui-line bg-ui-base p-4 sm:p-5">
      {/* Header row */}
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          {sev.svg ? (
            <img src={sev.svg} alt={comment.severity} className="mt-px h-[18px] w-[18px] shrink-0" />
          ) : (
            <SevIcon size={15} className={cn('mt-px shrink-0', sev.iconColor)} />
          )}
          <span className="text-sm font-semibold leading-snug text-foreground">{comment.title}</span>
        </div>
        <span className={`severity-tag ${comment.severity} shrink-0`}>{comment.severity}</span>
      </div>

      {/* Meta: file · line */}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-ui-subtle">
        <span className="ui-font-mono flex items-center gap-1 rounded bg-card/60 px-1.5 py-0.5 text-[11px] text-foreground/70">
          <FileText size={10} /> {filePath}
        </span>
        {comment.line != null && (
          <span className="ui-font-mono tabular-nums">line {comment.line}</span>
        )}
        {comment.claimType && comment.claimType !== 'other' && (
          <span className="ui-font-mono rounded bg-card/60 px-1.5 py-0.5 text-[11px] text-ui-subtle">
            {comment.claimType.replace(/_/g, ' ')}
          </span>
        )}
        {/* A finding in this list did not necessarily reach the pull request -- the dashboard shows
            everything the model produced. Say which stage stopped it rather than leaving a filtered
            finding looking identical to a posted one. */}
        {comment.posted === false && comment.disposition && comment.disposition !== 'posted' && (
          <span
            className="ui-font-mono rounded bg-card/60 px-1.5 py-0.5 text-[11px] text-ui-subtle"
            title={DISPOSITION_LABEL[comment.disposition] ?? 'Not posted'}
          >
            not posted · {comment.disposition}
          </span>
        )}
      </div>

      {/* Body - stripped of suggestions to avoid duplication in UI */}
      <div className="prose prose-sm mb-4 max-w-none leading-relaxed text-foreground/90">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={safeRehypePlugins} components={markdownComponents}>
          {comment.body.split('```suggestion')[0].trim()}
        </ReactMarkdown>
      </div>

      {/* Code suggestion (UI view) */}
      {comment.codeSuggestion && (
        <div className="mt-4 border-t border-border/40 pt-4">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-ui-subtle">
            Suggested fix
          </p>
          <pre
            className="thin-scroll ui-font-mono overflow-x-auto rounded-md border p-3 text-[12px] leading-relaxed"
            style={{ background: 'var(--code-bg)', borderColor: 'var(--code-border)', color: 'var(--code-fg)' }}
          >
            {comment.codeSuggestion.replace(/```suggestion\n?|```/g, '').trim()}
          </pre>
        </div>
      )}
    </article>
  );
}
