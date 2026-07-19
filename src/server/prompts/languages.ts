export type LanguageGuideline = {
  language: string;
  extensions: string[];
  guidelines: string[];
  persona?: string;
};

export const LANGUAGE_GUIDELINES: LanguageGuideline[] = [
  {
    language: 'TypeScript/JavaScript',
    persona: 'an expert TypeScript engineer focused on correctness and safe async code',
    extensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],
    guidelines: [
      'Flag unhandled promise rejections, missing await, or async errors that can crash or silently drop work.',
      'Flag resource leaks that cause real bugs (uncleared timers/intervals/listeners on a path that runs repeatedly).',
      'Flag security pitfalls such as eval() on untrusted input or ReDoS-prone regexes.',
      'Flag runtime-breaking null/undefined access introduced by the diff.',
    ],
  },
  {
    language: 'Python',
    persona: 'a Python engineer focused on correctness',
    extensions: ['py'],
    guidelines: [
      'Flag mutable default arguments that cause shared-state bugs.',
      'Flag bare "except:" that swallows errors and hides failures.',
      'Flag incorrect exception handling or resource handling (files/sockets not closed).',
    ],
  },
  {
    language: 'React',
    persona: 'a senior React engineer focused on hook correctness',
    extensions: ['tsx', 'jsx'],
    guidelines: [
      'Flag missing/incorrect useEffect/useCallback/useMemo dependencies that cause stale-closure or infinite-loop bugs.',
      'Flag state updates on unmounted components or effects missing cleanup that leak.',
    ],
  },
  {
    language: 'CSS/SCSS/Less',
    persona: 'a frontend engineer',
    extensions: ['css', 'scss', 'sass', 'less'],
    guidelines: [
      'Flag only rules that break layout or rendering; do not report stylistic preferences.',
    ],
  },
  {
    language: 'SQL',
    persona: 'a database engineer focused on query safety and correctness',
    extensions: ['sql'],
    guidelines: [
      'Flag SQL injection risks (unparameterized/interpolated user input).',
      'Flag destructive or non-atomic migrations that risk data loss.',
    ],
  },
  {
    language: 'Markdown',
    persona: 'a technical writer',
    extensions: ['md', 'mdx'],
    guidelines: [
      'Flag only broken links/images or factually incorrect content; do not report style or grammar nits.',
    ],
  },
  {
    language: 'HTML',
    persona: 'a web engineer',
    extensions: ['html', 'htm'],
    guidelines: [
      'Flag only markup that is broken or functionally inaccessible; do not report SEO or style preferences.',
    ],
  },
  {
    language: 'JSON/Config',
    persona: 'a DevOps engineer',
    extensions: ['json', 'jsonc', 'yaml', 'yml', 'toml'],
    guidelines: [
      'Flag invalid syntax/schema or hardcoded secrets; do not report naming-convention preferences.',
    ],
  },
];

export function getLanguageForFile(path: string): LanguageGuideline | undefined {
  const ext = path.split('.').pop()?.toLowerCase();
  if (!ext) return undefined;

  const matches = LANGUAGE_GUIDELINES.filter((g) => g.extensions.includes(ext));
  
  if (matches.length === 0) return undefined;

  if (matches.length > 1) {
    return {
      language: matches.map(m => m.language).join(' & '),
      persona: matches.map(m => m.persona).filter(Boolean).join(' and '),
      extensions: Array.from(new Set(matches.flatMap(m => m.extensions))),
      guidelines: Array.from(new Set(matches.flatMap(m => m.guidelines))),
    };
  }

  return matches[0];
}
