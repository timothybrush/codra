# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets), used here only for
**local, manual** versioning of the public `@codraoss/*` packages. There is no CI-based publishing.

The seven publishable packages (`schema`, `core`, `db`, `models`, `provider-github`, `api`, `ui`)
are a **fixed group** — they version and release in lockstep (currently `0.9.4`). The worker app
(`@codraoss/worker`) is private and never published.

## Recording a change

```bash
npx changeset            # pick the bump, write a summary; commit the generated file
```

## Cutting a release (run locally, then publish by hand)

```bash
npm run version:packages   # applies pending changesets: bumps all @codraoss/* in lockstep + changelog
npm run release            # builds dist and runs `changeset publish` for you
```

`npm run release` builds every package to `dist/` and publishes. Publishing is also possible per
package with plain npm — the `prepack` hook rewrites `exports` to the compiled `dist/` paths in the
tarball automatically:

```bash
npm run build:packages
npm publish -w @codraoss/schema   # ...repeat bottom-up: schema → core → db/models/provider-github → api → ui
```

You must be logged in to npm (`npm whoami`) and own the `@codraoss` scope. First publish of each
package needs public access, which `publishConfig.access` already sets.
