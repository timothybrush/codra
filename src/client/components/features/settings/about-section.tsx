import pkg from '../../../../../package.json';
import { ExternalLink } from 'lucide-react';
import { SectionCard } from '@client/components/shared/section-card';
import { LayerCard } from '@client/components/ui/layer-card';
import { Text } from '@client/components/ui/text';
import { Badge } from '@client/components/ui/badge';

// Static: version, license and links, all read from package.json at build time. No props and no
// state, which is why it is a component rather than inlined JSX -- it keeps 50 lines of markup out
// of SettingsPage without threading anything through.
export function AboutSection() {
  return (
  <SectionCard
    title="About"
    description="Version, license, and links for this Codra instance"
  >
    {/* LayerCards: Version/License in one, the links grid in its own. */}
    <div className="space-y-3 p-5">

      {/* Version + License */}
      <LayerCard className="divide-y divide-ui-line rounded-lg">
        <div className="flex items-center justify-between gap-4 px-4 py-3.5">
          <Text variant="body" size="sm" bold as="span">Version</Text>
          <Badge
            variant="outline"
            className="border-ui-brand/30 bg-ui-brand/10 font-mono text-ui-brand"
          >
            v{pkg.version}
          </Badge>
        </div>
        <div className="flex items-center justify-between gap-4 px-4 py-3.5">
          <Text variant="body" size="sm" bold as="span">License</Text>
          <Badge variant="outline">{pkg.license}</Badge>
        </div>
      </LayerCard>

      {/* Links - original 3-column grid, in its own card */}
      <LayerCard className="rounded-lg">
        <div className="grid grid-cols-1 divide-y divide-ui-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {[
            { href: `${pkg.repository.url.replace(/\.git$/, '')}/releases/`, label: 'Releases', sub: 'Version history & notes' },
            { href: pkg.homepage, label: 'Homepage', sub: 'codra.run' },
            { href: pkg.bugs.url, label: 'Report an issue', sub: 'GitHub issue tracker' },
          ].map(({ href, label, sub }) => (
            <a
              key={label}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex flex-col gap-2.5 px-4 py-4 transition-colors hover:bg-ui-fill/40"
            >
              <span>
                <span className="flex items-center gap-1.5 text-sm font-semibold text-ui-default group-hover:text-ui-brand">
                  {label}
                  <ExternalLink size={11} className="text-ui-subtle opacity-0 transition-opacity group-hover:opacity-100 group-hover:text-ui-brand" />
                </span>
                <span className="mt-0.5 block text-xs text-ui-subtle">{sub}</span>
              </span>
            </a>
          ))}
        </div>
      </LayerCard>

    </div>
  </SectionCard>
  );
}
