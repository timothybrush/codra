# @codraoss/models

## 0.9.6

### Patch Changes

- Stop sending `propertyOrdering` in Gemini response grammars. The keyword belongs to the legacy OpenAPI-style `responseSchema`; inside `responseJsonSchema` the API rejects it with a bare 400 `invalid argument`, so every constrained Google review fell back to unconstrained decoding and frequently returned prose that failed the reviewable-output gate. Property declaration order already carries the ordering the grammar relied on.

## 0.9.5

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @codraoss/core@0.9.5
  - @codraoss/schema@0.9.5
