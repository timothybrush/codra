import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@client/lib/utils';

/**
 * Copies a block of text to the clipboard.
 *
 * Exists because drag-selecting a long, scrollable `<pre>` is miserable even when selection works --
 * the container scrolls while you drag, and you rarely get exactly the text you wanted. One click is
 * the reliable path for prompts and raw model output.
 */
export function CopyButton({
  value,
  label = 'Copy',
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  // The timeout outlives the component if the panel is collapsed right after a copy.
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
    // Clipboard access can be refused (insecure origin, permissions policy). Selecting the text by
    // hand still works, so failing quietly beats an error the user can do nothing about.
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? 'Copied' : label}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded border border-ui-line px-1.5 py-0.5',
        'text-[10px] font-medium transition-colors',
        copied ? 'text-emerald-500' : 'text-ui-subtle hover:text-foreground',
        className,
      )}
    >
      {copied ? <Check size={10} /> : <Copy size={10} />}
      {copied ? 'Copied' : label}
    </button>
  );
}
