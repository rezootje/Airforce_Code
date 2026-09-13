# Changelog

All user-visible changes are documented here. Versions follow Semantic Versioning.

## [1.1.3] - 2026-09-13

- Keep completed first-run onboarding completed across launches; missing or expired credentials now open the focused authentication flow instead of restarting setup.
- Let interactive launches recover a missing model through the model picker without repeating onboarding.
- Make temporary-workspace tests compare canonical paths on macOS and Windows so the full CI matrix validates the same security behavior.
- Update official GitHub Actions to their Node 24-based releases, normalize text files to LF across platforms, and apply POSIX permission-bit assertions only on POSIX systems.

## [1.1.2] - 2026-09-13

- Show request phases, streamed command output and assistant Markdown lines as work happens.
- Detect stalled API response streams and report stable `STREAM_TIMEOUT` or `API_TIMEOUT` errors.
- Recover session locks left behind by terminated Airforce processes while preserving live-process locks.
- Add repository metadata required for NPM trusted-publishing provenance verification.

## [0.1.1] - 2026-09-13

Release candidate.

- Add explicit default api.airforce or custom endpoint setup, with OAuth restricted to the default service.
- Complete terminal status dashboard and Markdown rendering improvements.

## [0.1.0] - 2026-09-13

Initial, unpublished implementation.

- Add configurable api.airforce provider adapters, live model discovery and terminal onboarding.
- Add native OAuth login/logout using the registered public client, PKCE S256, validated loopback callbacks, expiry handling and revocation.
- Add one-time Airforce Code onboarding, per-directory consent, a branded workspace, and trust management commands.
- Add live searchable slash-command completion and improve searchable model selection.
- Add Escape request cancellation, a terminal-sized scrolling command palette, and visible error codes.
- Rename the NPM package to `airforce-code` while retaining `airforce` and `airforce-code` executables.
- Refine the responsive Airforce Code wordmark and framed prompt, and add a timed activity indicator that follows agent and tool events.
- Add focused `auth` and `/auth` flows for validated API-key replacement and OAuth reauthentication without repeating first-run setup.
- Add searchable project-scoped session resume, durable token totals, model-picker pricing, and running estimated session cost from provider usage.
- Replace `/status` JSON with a compact project, model, context, cost, and Git dashboard; render streamed GFM with terminal typography, tables, links, task lists, and syntax-highlighted code fences.
- Add a multi-step tool agent, headless JSON/JSONL interface, sessions and context compaction.
- Add guarded repository tools, optimistic patches, edit journal, undo/redo, command approvals and Git ownership checks.
- Add instruction-file compatibility and application-enforced question-first mode.
- Add approved stdio MCP, tool hooks and a dedicated PNG generation capability.
- Add adversarial/provider/integration tests, CI, NPM packaging checks and release documentation.

Known release gates and deferred features are tracked in `docs/STATUS.md`.
