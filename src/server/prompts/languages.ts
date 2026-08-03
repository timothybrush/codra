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
  // A React entry used to live here with extensions ['tsx', 'jsx'] and a "flag missing
  // useEffect/useCallback/useMemo dependencies" guideline. Both of those extensions are ALSO in the
  // TypeScript/JavaScript entry above, so every .tsx file matched twice: getLanguageForFile merged
  // the two, concatenating both personas ("an expert TypeScript engineer ... and a senior React
  // engineer focused on hook correctness") and unioning both guideline sets.
  //
  // The effect was measurable. Hook-dependency findings were 10x concentrated in .tsx (3.7% of
  // files vs 0.36% for .ts) while findings-per-file stayed flat -- the checklist did not make the
  // model find more, it dictated what it "found". That claim family is 0-posted-out-of-28 across
  // the entire production corpus, and six of them were the false positives that prompted this
  // change: "useEffect is missing a dependency array" on lines containing no useEffect.
  //
  // Removed rather than reworded: the base prompt already covers correctness and async safety for
  // these files, and a checklist the model completes is worse than no checklist at all.
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

  // On an overlap, take the single most specific entry rather than merging. Merging stacked two
  // personas and two checklists onto one file, which is how .tsx ended up being told to hunt for
  // hook-dependency bugs. Narrower extension list == more specific.
  if (matches.length > 1) {
    return matches.reduce((best, candidate) =>
      candidate.extensions.length < best.extensions.length ? candidate : best,
    );
  }

  return matches[0];
}
