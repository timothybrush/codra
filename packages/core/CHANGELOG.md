# @codraoss/core

## 0.9.5

### Patch Changes

- Raise `MAX_TOTAL_DIFF_CHARS` to 4,000,000 and centralise it in the package constants. Files dropped by the file-count and diff-size limits now mark a review as partial and are named in the job status, rather than appearing only in the pull request comment.
- Updated dependencies
  - @codraoss/schema@0.9.5
