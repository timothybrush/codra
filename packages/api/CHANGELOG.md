# @codraoss/api

## 0.9.5

### Patch Changes

- Add optional extension points. `createApiRouter(options?)` accepts `beforeAuth`, `afterAuth`, `pages`, `publicPages` and `routes`; `routes` is invoked last so anything mounted under `/api/*` still inherits the session and CSRF middleware. `ApiRouterDeps` gains optional `authz` and `checkQuota` ports, and every mutating endpoint is now checked against them. Both default to allow-all, so calling `createApiRouter()` with no arguments is unchanged. Quota denial on the webhook path answers 202-ignored rather than 429, because GitHub redelivers failed deliveries.
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @codraoss/core@0.9.5
  - @codraoss/db@0.9.5
  - @codraoss/schema@0.9.5
  - @codraoss/models@0.9.5
  - @codraoss/provider-github@0.9.5
