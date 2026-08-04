import { useState, type ComponentPropsWithoutRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { FileText, ThumbsDown, ThumbsUp } from 'lucide-react';
import { cn } from '@client/lib/utils';
import { api } from '@client/lib/api';
import { CopyButton } from '@client/components/shared/copy-button';
import { preventToggleOnTextSelection } from '@client/lib/selection';
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
  verify_unanswered: 'The verification pass returned no verdict for this finding',
  cap: 'Over the max-comments limit for a single review',
  unverifiable_passthrough: 'Could not be verified — no diff context was available',
};

interface CommentCardProps {
  comment: ParsedReviewComment;
  filePath: string;
  /** Omitted for jobs whose findings cannot be labelled (no id available). */
  jobId?: string;
}

export function CommentCard({ comment, filePath, jobId }: CommentCardProps) {
  const sev = severityConfig[comment.severity] ?? severityConfig.nit;
  const SevIcon = sev.icon;

  // Optimistic, and reverted on failure. Labelling is the only path by which ground truth ever
  // reaches this system, so it has to be one click with no dialog -- but a 'wrong' label suppresses
  // the finding across the whole repository, so the button says so before it is pressed.
  const [label, setLabel] = useState(comment.humanLabel ?? null);
  const [saving, setSaving] = useState(false);

  const apply = async (next: 'marked_right' | 'marked_wrong') => {
    if (!jobId || !comment.fingerprint || saving) return;
    const previous = label;
    const clearing = label === next;
    setLabel(clearing ? null : next);
    setSaving(true);
    try {
      if (clearing) await api.clearFindingLabel(jobId, comment.fingerprint);
      else await api.setFindingLabel(jobId, comment.fingerprint, next === 'marked_wrong' ? 'wrong' : 'right');
    } catch {
      setLabel(previous);
    } finally {
      setSaving(false);
    }
  };

  const canLabel = Boolean(jobId && comment.fingerprint);

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
        {canLabel && (
          <span className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => apply('marked_right')}
              disabled={saving}
              aria-pressed={label === 'marked_right'}
              title="Mark this finding as correct. Recorded for accuracy measurement only — it does not change future reviews."
              className={cn(
                'flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] transition-colors disabled:opacity-50',
                label === 'marked_right'
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
                  : 'border-ui-line text-ui-subtle hover:text-foreground',
              )}
            >
              <ThumbsUp size={11} /> Correct
            </button>
            <button
              type="button"
              onClick={() => apply('marked_wrong')}
              disabled={saving}
              aria-pressed={label === 'marked_wrong'}
              title="Mark this finding as a false positive. It will not be reported again anywhere in this repository until you undo this."
              className={cn(
                'flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] transition-colors disabled:opacity-50',
                label === 'marked_wrong'
                  ? 'border-rose-500/40 bg-rose-500/10 text-rose-500'
                  : 'border-ui-line text-ui-subtle hover:text-foreground',
              )}
            >
              <ThumbsDown size={11} /> Wrong
            </button>
          </span>
        )}
      </div>

      {/* The verifier's own words. Parsed and thrown away until now, which made the one stage whose
          job is subtraction the one stage nobody could tune. */}
      {comment.verifyReason && (
        <p className="mb-3 border-l-2 border-ui-line pl-2 text-xs italic text-ui-subtle">
          Verifier: {comment.verifyReason}
        </p>
      )}

      {/* Body - stripped of suggestions to avoid duplication in UI */}
      <div className="prose prose-sm mb-4 max-w-none leading-relaxed text-foreground/90">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={safeRehypePlugins} components={markdownComponents}>
          {comment.body.split('```suggestion')[0].trim()}
        </ReactMarkdown>
      </div>

      {/* The diff context the claim was judged against, captured at parse time. Collapsed so it
          doesn't dominate the card, but present: a human cannot label a finding they cannot see, and
          this is the only surviving copy (migration 003 nulls diff_input, the KV cache is 6h). */}
      {comment.contextSnippet && (
        <details className="mb-4 text-xs">
          <summary
            onClick={preventToggleOnTextSelection}
            className="cursor-pointer text-ui-subtle hover:text-foreground"
          >
            Diff context
          </summary>
          <div className="mt-2 flex justify-end">
            <CopyButton value={comment.contextSnippet} label="Copy diff" />
          </div>
          <pre
            className="thin-scroll ui-font-mono mt-2 overflow-x-auto rounded-md border p-3 text-[12px] leading-relaxed"
            style={{ background: 'var(--code-bg)', borderColor: 'var(--code-border)', color: 'var(--code-fg)' }}
          >
            {comment.contextSnippet}
          </pre>
        </details>
      )}

      {/* Code suggestion (UI view) */}
      {comment.codeSuggestion && (
        <div className="mt-4 border-t border-border/40 pt-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ui-subtle">
              Suggested fix
            </p>
            <CopyButton value={comment.codeSuggestion.replace(/```suggestion\n?|```/g, '').trim()} />
          </div>
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
