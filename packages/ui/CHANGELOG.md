# @codraoss/ui

## 0.9.5

### Patch Changes

- Ship the design tokens as `@codraoss/ui/styles`. The components reference `--ui-*`, `--btn-primary-*`, `surface`, `skeleton`, `ui-panel`, `ui-well` and `ui-font-*`, none of which were published before, so the package rendered unstyled outside this repository. Import it after `@import "tailwindcss"` and include the package in your Tailwind source globs.
- Updated dependencies
  - @codraoss/schema@0.9.5
