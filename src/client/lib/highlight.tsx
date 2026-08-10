import type { ReactNode } from 'react';

/**
 * Tiny regex-based per-line syntax highlighter for the diff viewer. Tokenizes one line at a
 * time; multi-line block comments fall back to plain text - the standard trade-off for cheap
 * diff highlighting.
 */

export type Lang = 'js' | 'py' | 'sh' | 'css' | 'html' | 'json' | 'sql' | 'clike' | 'md' | 'plain';

const EXT_LANG: Record<string, Lang> = {
  ts: 'js', tsx: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', mts: 'js', cts: 'js',
  vue: 'js', svelte: 'js',
  py: 'py', rb: 'py',
  sh: 'sh', bash: 'sh', zsh: 'sh', yml: 'sh', yaml: 'sh', toml: 'sh', env: 'sh',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', jsonc: 'json', json: 'json',
  sql: 'sql',
  go: 'clike', rs: 'clike', java: 'clike', kt: 'clike', c: 'clike', h: 'clike',
  cpp: 'clike', hpp: 'clike', cs: 'clike', swift: 'clike', php: 'clike',
  md: 'md', markdown: 'md', mdx: 'md', mdc: 'md',
};

export function langForPath(path: string): Lang {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return EXT_LANG[ext] ?? 'plain';
}

const JS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
  'switch', 'case', 'default', 'break', 'continue', 'new', 'delete', 'typeof',
  'instanceof', 'in', 'of', 'class', 'extends', 'implements', 'interface', 'type',
  'enum', 'namespace', 'import', 'export', 'from', 'as', 'async', 'await', 'yield',
  'try', 'catch', 'finally', 'throw', 'this', 'super', 'null', 'undefined', 'true',
  'false', 'void', 'never', 'unknown', 'any', 'string', 'number', 'boolean', 'object',
  'symbol', 'bigint', 'readonly', 'public', 'private', 'protected', 'static', 'get',
  'set', 'keyof', 'infer', 'satisfies', 'declare', 'abstract', 'is',
]);

const PY_KEYWORDS = new Set([
  'def', 'return', 'if', 'elif', 'else', 'for', 'while', 'break', 'continue', 'pass',
  'import', 'from', 'as', 'class', 'try', 'except', 'finally', 'raise', 'with',
  'lambda', 'yield', 'global', 'nonlocal', 'assert', 'del', 'in', 'not', 'and', 'or',
  'is', 'None', 'True', 'False', 'async', 'await', 'self', 'match', 'case',
  'begin', 'end', 'module', 'require', 'nil', 'puts', 'attr_accessor',
]);

const SH_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac',
  'function', 'return', 'local', 'export', 'echo', 'exit', 'set', 'source', 'true', 'false',
]);

const SQL_KEYWORDS = new Set([
  'select', 'from', 'where', 'and', 'or', 'not', 'insert', 'into', 'values', 'update',
  'set', 'delete', 'create', 'table', 'alter', 'drop', 'index', 'join', 'left', 'right',
  'inner', 'outer', 'on', 'as', 'group', 'by', 'order', 'having', 'limit', 'offset',
  'distinct', 'union', 'all', 'null', 'primary', 'key', 'foreign', 'references',
  'default', 'unique', 'constraint', 'with', 'returning', 'exists', 'between', 'like',
  'ilike', 'case', 'when', 'then', 'else', 'end', 'count', 'sum', 'avg', 'max', 'min',
]);

const CLIKE_KEYWORDS = new Set([
  'func', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
  'break', 'continue', 'struct', 'interface', 'type', 'map', 'chan', 'go', 'defer',
  'select', 'package', 'import', 'var', 'const', 'range', 'nil', 'true', 'false',
  'fn', 'let', 'mut', 'impl', 'trait', 'enum', 'match', 'mod', 'pub', 'use', 'crate',
  'self', 'Self', 'async', 'await', 'move', 'ref', 'where', 'dyn', 'Some', 'None',
  'Ok', 'Err', 'class', 'extends', 'public', 'private', 'protected', 'static', 'final',
  'void', 'int', 'long', 'float', 'double', 'bool', 'boolean', 'char', 'string',
  'new', 'this', 'super', 'null', 'try', 'catch', 'finally', 'throw', 'throws',
]);

const KEYWORDS: Record<Lang, Set<string>> = {
  js: JS_KEYWORDS,
  py: PY_KEYWORDS,
  sh: SH_KEYWORDS,
  css: new Set(),
  html: new Set(),
  json: new Set(['true', 'false', 'null']),
  sql: SQL_KEYWORDS,
  clike: CLIKE_KEYWORDS,
  md: new Set(),
  plain: new Set(),
};

// Groups: 1 line comment, 2 string, 3 number, 4 identifier
const TOKEN_RE: Record<'slash' | 'hash' | 'dashdash', RegExp> = {
  slash: /(\/\/.*|\/\*.*?(?:\*\/|$)|<!--.*?(?:-->|$))|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d(?:[\w.]*)\b)|([A-Za-z_$][\w$]*)/g,
  hash: /(#.*)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(\b\d(?:[\w.]*)\b)|([A-Za-z_$][\w$]*)/g,
  dashdash: /(--.*|\/\*.*?(?:\*\/|$))|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(\b\d(?:[\w.]*)\b)|([A-Za-z_$][\w$]*)/g,
};

function tokenRegexFor(lang: Lang): RegExp {
  if (lang === 'py' || lang === 'sh') return TOKEN_RE.hash;
  if (lang === 'sql') return TOKEN_RE.dashdash;
  return TOKEN_RE.slash;
}

// Inline spans: code, bold, italic, links, strikethrough. Raw markdown syntax is kept (this
// renders diff source) and just colored.
const MD_INLINE_RE =
  /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*(?!\s)[^*]+\*|_(?!\s)[^_]+_)|(!?\[[^\]]*\]\([^)]*\))|(~~[^~]+~~)/g;

function highlightMarkdownInline(text: string, keyStart = 0): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = keyStart;
  let match: RegExpExecArray | null;
  const re = new RegExp(MD_INLINE_RE.source, 'g');

  while ((match = re.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const [full, code, bold, italic, link, strike] = match;
    if (code !== undefined) {
      out.push(<span key={key++} className="tok-str">{full}</span>);
    } else if (bold !== undefined) {
      out.push(<span key={key++} className="tok-strong">{full}</span>);
    } else if (italic !== undefined) {
      out.push(<span key={key++} className="tok-em">{full}</span>);
    } else if (link !== undefined) {
      out.push(<span key={key++} className="tok-fn">{full}</span>);
    } else if (strike !== undefined) {
      out.push(<span key={key++} className="tok-com">{full}</span>);
    }
    last = match.index + full.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function highlightMarkdownLine(text: string): ReactNode {
  if (/^\s{0,3}#{1,6}\s/.test(text)) {
    return <span className="tok-md-head">{text}</span>;
  }
  const quote = /^(\s*>\s?)(.*)$/.exec(text);
  if (quote) {
    return [
      <span key="q" className="tok-com">{quote[1]}</span>,
      ...highlightMarkdownInline(quote[2], 1),
    ];
  }
  const list = /^(\s*(?:[-*+]|\d+\.)\s+)(\[[ xX]\]\s+)?(.*)$/.exec(text);
  if (list && list[1]) {
    const parts: ReactNode[] = [<span key="m" className="tok-kw">{list[1]}</span>];
    if (list[2]) parts.push(<span key="t" className="tok-num">{list[2]}</span>);
    parts.push(...highlightMarkdownInline(list[3] ?? '', 2));
    return parts;
  }
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(text)) {
    return <span className="tok-com">{text}</span>;
  }
  return highlightMarkdownInline(text);
}

export function highlightLine(text: string, lang: Lang): ReactNode {
  if (lang === 'plain' || text.length === 0 || text.length > 1000) return text;

  if (lang === 'md') return highlightMarkdownLine(text);

  const keywords = KEYWORDS[lang];
  const re = new RegExp(tokenRegexFor(lang).source, 'g');
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));

    const [full, comment, str, num, ident] = match;
    if (comment !== undefined) {
      out.push(<span key={key++} className="tok-com">{full}</span>);
    } else if (str !== undefined) {
      out.push(<span key={key++} className="tok-str">{full}</span>);
    } else if (num !== undefined) {
      out.push(<span key={key++} className="tok-num">{full}</span>);
    } else if (ident !== undefined) {
      const lookup = lang === 'sql' ? ident.toLowerCase() : ident;
      if (keywords.has(lookup)) {
        out.push(<span key={key++} className="tok-kw">{full}</span>);
      } else if (text[match.index + full.length] === '(') {
        out.push(<span key={key++} className="tok-fn">{full}</span>);
      } else if (/^[A-Z]/.test(ident) && lang !== 'html') {
        out.push(<span key={key++} className="tok-type">{full}</span>);
      } else {
        out.push(full);
      }
    }

    last = match.index + full.length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}
