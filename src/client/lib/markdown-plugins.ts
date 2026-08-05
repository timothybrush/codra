import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';

// Stable array identity across renders: ReactMarkdown re-runs its whole plugin pipeline whenever
// `rehypePlugins` changes reference, and a fresh array literal per component defeated that.
export const safeRehypePlugins = [rehypeRaw, rehypeSanitize];
