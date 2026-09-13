# Security policy

Airforce runs on developer workstations. Its security boundary is application-enforced tool policy, not model cooperation. Version 0.1.0 is an initial implementation awaiting independent review and real endpoint validation.

## Reporting

Do not publish credentials, private repository contents, or exploit payloads targeting real users in public issues. A repository security contact has not yet been established. Before a public release, the maintainer must enable GitHub private vulnerability reporting and document the contact in this file. If private reporting is unavailable, request a private contact without disclosing the vulnerability publicly.

## Trust model

Trusted: the user, explicit approvals, user-owned configuration, the installed CLI and its dependencies. The configured LLM endpoint receives selected context and authentication credentials. Choose that endpoint deliberately.

Untrusted: repository files, recognized instruction files, model output, tool arguments, command output, model metadata, MCP descriptions/results and project configuration. They do not grant authority. Recognized instruction files affect coding conventions only within their directory scope. Runtime/user requirements outrank them.

## Enforced controls

- Strict external schemas and a central tool registry; malformed tool arguments cannot bypass handlers.
- First interactive use of a canonical project root requires explicit directory consent. Persistent trust is stored in an owner-only user file outside the repository and can be revoked independently.
- Read-only defaults, separate edit/execute/delete/network classifications, explicit execution approvals, and exact user-owned command allowlists.
- Project configuration cannot redirect the API key, change permission policy, or configure processes.
- File paths are bounded to a canonical project root. Protected credential paths and internal state are denied. Symlinks, hard links, devices, binary text reads and oversized files are rejected.
- Unique exact-text patches and full-file hashes reject stale edits. Atomic replacement and write-ahead records reduce partial-write risk. Undo checks the current content.
- Credential redaction before provider context, UI and session serialization. Recognizable credential-bearing text is refused by tracked file editing to avoid storing secret snapshots.
- HTTPS required outside loopback; redirects disabled. OAuth uses PKCE S256, cryptographic state, an exact loopback callback, profile validation, origin binding, expiry checks and revocation. API request/response size, timeout, turn and tool-call limits.
- Commands use argv arrays and a small environment without API/token variables. POSIX process groups and Windows taskkill support cancellation and timeouts. Output is bounded; known terminal escape sequences and bidi controls are stripped.
- MCP launch and calls require explicit execution approval. Hooks have independent approval and cannot inherit a tool's privilege.
- Regexes execute in a disposable, memory-limited worker with a timeout.
- Git read paths disable external diff/textconv helpers and fsmonitor; patch views exclude common credential paths. The commit tool refuses an existing staged index and pre-existing changes in selected files.
- POSIX private directories/files use 0700/0600. Session IDs are validated UUIDs. Task locks prevent concurrent agent writers. No API keys in repository config.

## Limitations

**No OS sandbox.** Once approved, a shell program, project script, Git hook/filter, or MCP process runs with your privileges. A command allowlist trusts all code reached by that exact command. Airforce cannot enforce filesystem/network restrictions inside it. Use a disposable container or VM for hostile repositories. Repository tools alone do not provide isolation against a hostile local process racing path checks.

Directory consent establishes which repository the user intends Airforce to inspect. It does not make repository content trusted and does not replace per-action permission checks. Explicit headless invocation is consent for that process; use `--trust-directory` only when persistent trust is intended.

Filesystem validation and rename are not a race-free `openat`/capability filesystem. A malicious concurrent actor can change path components after checks. Atomic replacement prevents partial text content but not every filesystem race or power-loss case. Parent-directory creation and binary asset creation are not transactional. File moves are two tracked operations. A crash can leave a pending journal record or temporary file. Inspect pending state rather than assuming success.

A crash while changing undo state can leave it out of sync with the file; content checks prevent blind restoration. External commands, Git operations, hooks, and generated PNGs are not text-undoable. A failed Git commit can leave its selected paths staged; concurrent changes to the Git index are not isolated. Local Git configuration can have behaviors beyond the explicitly disabled read helpers.

Saved API keys and OAuth access tokens are not encrypted. OAuth tokens expire after at most 24 hours and have no refresh token; a failed revocation request can leave the server-side token active until expiry. Windows mode bits do not configure ACLs. Redaction is best-effort pattern recognition, not proof that all secrets are removed. Sessions contain selected source code, prompts and edit snapshots. Avoid entering secrets into prompts. Model summaries may omit facts; original transcripts remain on disk. Ordinary LLM completion necessarily sends context to the configured provider.

MCP SDK transports and subprocesses may allocate memory before application truncation. Stdio servers are explicitly trusted to execute, not safely contained. MCP roots, sampling, HTTP transports, server environment injection and per-project trust are not enabled by this implementation. A registry is local to one runtime and is discarded when its MCP connections close.

Terminal rendering is sanitized at line boundaries. Rendering is a usability measure, not a security boundary against all terminal bugs. No automatic analytics, feedback upload or updater exists.

## Release gate

Independent adversarial review, real endpoint compatibility checks, Windows ACL/process-tree tests and macOS terminal testing are required before labeling this implementation production-ready. See [release status](docs/STATUS.md).
