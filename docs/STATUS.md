# Scope and release status

This is a working initial implementation, not a claim that every item in the product specification has been completed or independently secured.

## Implemented

- TypeScript/ESM, strict typing, Node 24+, NPM executable and public engine exports.
- One-time branded onboarding plus validated API-key replacement, native OAuth reauthentication/logout with PKCE, callback validation, expiry/origin checks and revocation; searchable live model discovery with capability and per-million-token pricing.
- Per-directory consent with canonical owner-only trust storage and CLI list/trust/revoke management.
- OpenAI streaming/non-streaming and Anthropic streaming adapters, fragmented tool assembly, bounded HTTP/SSE and normalized events.
- Multi-step agent, validated extensible tools, retries, cancellation, iteration limits, tool-error feedback and persisted tasks.
- Guarded file/range reads, metadata, directory/filename/glob/literal/isolated-regex search, exact patches, create/write/delete/copy/move, tracked undo/redo.
- Application permissions, exact argv grants, protected paths, credential/terminal redaction, argv execution, output/time/process limits.
- Git status/diff/staged/log/show/blame/branch inspection, approved branch/index/commit workflows, commit ownership checks.
- Shallow multi-language repository detection, nested ignore files, instruction provenance/precedence, contextual reads and compaction with retained requirements/history.
- Sessions: new/list/load/rename/delete/fork/searchable-resume/history/export, atomic JSON and locks, provider token totals and running estimated cost.
- Question-first enforcement, branded framed input, animated working status, bounded searchable/scrolling slash-command palette, Escape cancellation, coded errors, terminal Markdown rendering with syntax highlighting, a context/cost/Git status dashboard, headless prompts/pipelines, pure JSON/JSONL and output files.
- Global stdio MCP connection and tool adapters through approval; explicit command hooks; one-PNG media generation adapter/tool.
- Unit, provider, security, process, Git, onboarding and spawned-CLI tests using synthetic data.
- CI matrix, packaging smoke test, release workflow, API opt-in harness, contributor/security/architecture documentation.

## Explicitly deferred

- OS sandbox backends; native keychain and Windows ACL management; OAuth refresh tokens (the provider does not issue them yet).
- Full-screen/Ink UI, collapsible tool views, reverse history search and live input steering during generation.
- True tokenizer-based budgets, AST/dependency graph indexing, persistent model/index caches and embeddings.
- Model-specific parameter negotiation beyond known tool/streaming/context capabilities and configured temperature/output budget; Anthropic non-streaming mode.
- Rich command pattern DSL and external-directory grants. Current command grants are exact argv, and file access is strictly within the project.
- Per-project MCP trust onboarding, MCP HTTP transports, project server settings, custom environment grants and server pagination.
- Connected web/search and GitHub adapters; their extension contracts exist but perform no actions.
- Session lifecycle hooks, plugin/skill package loading, custom slash-command packages and plugin marketplace.
- Image URLs, other media formats, binary undo, and real media endpoint verification.
- Automatic update checks, telemetry, debug-log UI, `/feedback` and feedback uploads.
- Transactional multi-file edits, OS-level filesystem race resistance, transactional Git index/commit isolation, automatic recovery of every interrupted mutation.

## Before public production release

1. Run `test:api` against the api.airforce production endpoint and representative model families; verify tool calling and both advertised protocols. OAuth transport is covered by synthetic local tests, while a real account login and model request still need release validation.
2. Run the configured CI matrix; review Windows process-tree cancellation/ACLs and macOS onboarding/terminal resizing manually.
3. Commission an independent security review of execution grants, MCP, config/secret storage, filesystem races, instruction scope and Git ownership.
4. Confirm `airforce-code` registry ownership, repository ownership, license ownership, trusted publishing configuration and private security reporting contact.
5. Review usability with real users and finish the release-critical terminal gaps. Keep documented conservative execution semantics unless an actual sandbox is supplied.
6. Decide which deferred features are required for the public 1.0 scope. Do not advertise them as implemented.

No publishing, deployment, Git initialization or paid API usage is performed by the implementation workflow itself.
