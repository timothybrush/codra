# @codraoss/db

## 0.9.5

### Patch Changes

- Publish `migrations/` and `scripts/`, which were excluded from the tarball, so an installed copy can create its schema. The runner now accepts `--extra-dir` or `CODRA_EXTRA_MIGRATIONS_DIR`: those migrations run after the built-in set inside the same transaction and advisory lock, and are tracked under an `extra:` prefix so filenames cannot collide with future core migrations. Env-file lookup checks the working directory first so it works when run from `node_modules`.
- Updated dependencies
- Updated dependencies
  - @codraoss/core@0.9.5
  - @codraoss/schema@0.9.5
