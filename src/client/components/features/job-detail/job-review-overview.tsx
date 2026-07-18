import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { ClipboardList } from 'lucide-react';
import { Badge } from '@client/components/ui/badge';
import type { JobDetail } from '@shared/schema';
import { reviewSeverities } from '@shared/schema';

const safeRehypePlugins = [rehypeRaw, rehypeSanitize];

interface JobReviewOverviewProps {
  job: JobDetail;
}

export function JobReviewOverview({ job }: JobReviewOverviewProps) {
  const hasOverview = !!(job.summaryMarkdown || job.overallCorrectness || (job.overallConfidenceScore !== undefined && job.overallConfidenceScore !== null));
  if (!hasOverview) return null;

  const allComments = job.files.flatMap((f) => f.parsedComments);
  const sevCounts = Object.fromEntries(
    reviewSeverities.map((s) => [s, allComments.filter((c) => c.severity === s).length]),
  );

  const renderSummary = () => {
    if (!job.summaryMarkdown) return '';
    let content = job.summaryMarkdown.replace(/^(✅ \*\*Approved\*\*|💬 \*\*Comments posted\*\*)\n\n/, '').trim();

    // Strip only the "### ... Codra Review" heading, keep the intro sentence
    const stripHeader = (md: string) => md
      .replace(/^###\s*(<picture>[\s\S]*?<\/picture>|💡)\s*Codra Review\s*\n+/, '')
      .trim();

    if (content.startsWith('### 💡 Codra Review') || content.includes('Codra Review')) {
      return stripHeader(content);
    }

    const shortSha = job.commitSha.slice(0, 10);
    const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';

    return `Here are some automated review suggestions for this pull request.\n\n**Reviewed commit:** \`${shortSha}\`\n\n<details>\n<summary>ℹ️ About Codra</summary>\n\n<br/>\n\n[Your team has set up Codra to review pull requests in this repo](${baseUrl}/repos). Reviews are triggered when you:\n\n- **Open** a pull request for review\n- **Mark** a draft as ready\n- **Comment** "@codra-app review"\n\nIf Codra has suggestions, it will comment; otherwise it will react with 👍.\n\nCodra can also answer questions or update the PR. Try commenting "@codra-app address that feedback".\n\n</details>\n\n---\n\n${content}`;
  };

  return (
    <div className="ui-panel ui-font-sans min-w-0 overflow-hidden">
      {/* Header */}
      <div className="flex flex-col items-start justify-between gap-3 border-b border-ui-line px-4 py-3 sm:flex-row sm:items-center sm:gap-0 sm:px-5">
        <div className="flex items-center gap-2">
          <ClipboardList size={15} strokeWidth={2} className="shrink-0 text-ui-default" />
          <h2 className="text-[13px] font-medium text-ui-default">Review overview</h2>
        </div>
        <div className="flex items-center gap-3">
          {job.overallCorrectness && (
            <Badge
              variant={job.overallCorrectness.toLowerCase().includes('incorrect') ? 'danger' : 'success'}
              className="uppercase tracking-wider"
            >
              {job.overallCorrectness}
            </Badge>
          )}
          {(job.overallConfidenceScore !== undefined && job.overallConfidenceScore !== null) && (
            <div className="flex flex-col items-end">
              <span className="mb-0.5 text-[9px] font-semibold uppercase leading-none tracking-[0.14em] text-ui-subtle">Confidence</span>
              <span className="ui-font-mono text-sm leading-none tabular-nums text-ui-strong">{(Number(job.overallConfidenceScore) * 100).toFixed(0)}%</span>
            </div>
          )}
        </div>
      </div>

      {/* Summary */}
      <div className="px-4 py-5 sm:px-5">
        <div className="prose max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={safeRehypePlugins}>
            {renderSummary()}
          </ReactMarkdown>
        </div>
      </div>

      {/* Severity Triage */}
      <div className="ui-well border-t border-ui-line px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ui-subtle">Priority triage</p>
          {reviewSeverities.map((sev) => {
            const count = sevCounts[sev] || 0;
            if (count === 0 && sev !== 'nit') return null;

            return (
              <div key={sev} className="flex items-center gap-1.5">
                <span className={`severity-tag ${sev} ${count === 0 ? 'opacity-40' : ''}`}>{sev}</span>
                <span className="ui-font-mono text-sm tabular-nums text-ui-default">{count}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
