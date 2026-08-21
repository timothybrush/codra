# Changelog

## v0.9.5

### What's New

- **Monorepo & Public npm Packages:** Codra is now an npm workspace monorepo, with the review engine, model adapters, GitHub provider, API router, and design system published under `@codraoss/*`.
- **Evidence-Grounded Findings:** Findings must quote the diff they claim to describe; candidates that can't ground themselves are dropped before posting.
- **Precision Gates & Gatekeeper Verifier:** A claim-type denylist, a dedicated verifier pass, and disposition tracking for degraded reviews.
- **Batched Reviews & New Providers:** Files are packed into bins with structured Gemini output; Vertex AI, NVIDIA, and xAI joined the model catalog.
- **Language Personas & Secondary Reviewer:** Configurable per-language personas and an optional second reviewer pass.
- **Clean-Pass Summaries:** A review that finds nothing now posts a real summary and reacts with a thumbs-up instead of an empty comment.
- **Job Detail & Stats Overhaul:** Rebuilt views with new chart primitives and bucketed trends.

### Bug Fixes

- Fixed `GET /api/jobs/:id` returning 503s while polling — Cloudflare's edge rewrites strong ETags to weak ones, so the 304 path never matched.
- Dropped an invalid `propertyOrdering` keyword from Gemini response grammars that was silently disabling constrained decoding on every Google review.
- Fixed issue-accuracy and "files reviewed" reporting, telemetry/repo settings UI, and CI dependency install failures.

**Full Changelog**: https://github.com/devarshishimpi/codra/compare/v0.9.4...v0.9.5

## v0.9.4

### What's New

- **Job Cancellation & Deletion:** Review jobs can now be cancelled and deleted directly, with improved job status handling.
- **Telemetry Opt-Out:** Anonymous telemetry now ships with a clear opt-out and support for overriding the telemetry secret.
- **Concurrency Controls:** Model calls now respect configurable concurrency limits, with enhanced timeout handling to keep reviews from stalling.
- **Custom File Matchers:** Diff parsing and the review flow were refactored to support custom file matchers.
- **Review Performance Settings:** New settings and UI for tuning review performance.
- **Motion UI:** Smooth scrolling (Lenis) and new motion-based sidebar navigation, tabs, and select components.
- **New Installs Experience:** Improved UI and skeleton loaders for new installs.

### Improvements

- Added in-memory token caching for GitHub requests to reduce redundant API calls.
- Job continuation tracking added so long-running reviews resume more reliably under concurrency limits.
- Improved handling of subrequest budget limits during review job processing.
- Enhanced review job concurrency handling and caching mechanisms.
- Improved model service caching, timeout handling, and review settings API, with added tests for concurrency limits.
- Enhanced CI configuration, select component accessibility, and optimized stats queries.
- Refactored stats page and model configurations.
- Removed dead letter queue (DLQ) functionality and related dead code.
- Updated font imports and improved the jobs search bar UI, with added stale repo cleanup.
- Bumped vulnerable packages.

### Bug Fixes

- Fixed a failing Google API test case.
- Fixed `onMouseEnter` typecheck issue.
- Fixed sidebar active button colors.

**Full Changelog**: https://github.com/devarshishimpi/codra/commits/v0.9.4

## v0.9.2

### What's New

- **UI Redesign:** Full visual overhaul of the dashboard, landing page, and auth flows with an updated color system, improved dark mode, and a cleaner layout overall.
- **Code Splitting:** All pages now use `React.lazy` for async loading, reducing initial bundle size and improving load times.
- **Custom LLM Providers:** Manage custom OpenAI-compatible API providers directly from the dashboard. Rate limits are optional. No more hardcoded keys in wrangler config.
- **Cloudflare Setup Script:** A new Node.js script automates the full Cloudflare deployment setup, making self-hosting significantly easier.
- **Increased Review Capacity:** Max files processed per review raised from 15 to 100.

### Improvements

- Review jobs are now resumable and lease-aware, stalled reviews can recover automatically.
- Added retry logic for transient model provider failures.
- Optimized job polling with ETag caching and adaptive delays.
- Improved settings UI, error reporting, and API robustness across the board.
- Added GitHub Actions CI with a disposable test environment for the full test suite.

### Bug Fixes

- Fixed `APP_PRIVATE_KEY` parsing for single-line strings with literal `\n` sequences.
- Fixed database migration failures on existing deployments.
- Fixed duplicate `/api/auth/updates-email` calls on page load.
- Fixed file review status bar rendering on the dashboard.

**Full Changelog**: https://github.com/devarshishimpi/codra/commits/v0.9.2
