# @codraoss/schema

## 0.9.5

### Patch Changes

- Export `apiActions`, the vocabulary of permission identifiers the API checks, and `ApiAction` as an open union so consumers can add their own names. `AuthSessionResponse` gains an optional `permissions` field; omitting it means every action is allowed.
