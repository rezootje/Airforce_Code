# Airforce Code

A permission-aware coding agent for your terminal, powered by a configurable **api.airforce** endpoint. Airforce searches repositories, reads files, applies checked patches, runs approved commands, inspects Git, and resumes multi-step engineering sessions.

**Status: initial implementation, version 0.1.0.** The local vertical slice and security/integration tests work against fake providers. This repository has not been published to NPM or validated against a real api.airforce account. See [release scope and remaining gates](docs/STATUS.md) before treating it as a production release.

## Install and run

Requires Node.js 24 or newer. Linux, macOS and Windows CI are configured; local validation was performed on Linux.

After publication under the selected package name:

```sh
npm install -g airforce-code
# or
npx airforce-code
```

To run this checkout now:

```sh
npm ci
npm run build
node dist/cli/main.js setup
node dist/cli/main.js
# Development
npm run dev -- --help
```

To test the actual installation path before publication:

```sh
npm run test:package
# Or install a locally generated tarball
npm pack
npm install -g ./airforce-code-0.1.0.tgz
```

The NPM package is `airforce-code`. Installation provides both `airforce` and `airforce-code` executable names; documentation uses the shorter `airforce` command. The package name remains centralized in `package.json`, and package verification reads it dynamically.

## First-time setup

```sh
airforce setup
```

Running `airforce` for the first time opens a guided setup. It connects an API key or OAuth account, validates the endpoint, loads models, provides a searchable model picker, and selects a default safety mode. Completion is remembered globally, so later launches go straight to the project consent screen or workspace. Run `airforce setup` whenever you want to repeat the flow.

Onboarding offers API-key authentication and **Sign in with Airforce — OAuth**. OAuth uses the system browser, Authorization Code with PKCE S256, a state-protected callback at `http://localhost:43821/oauth/callback`, profile validation, and Bearer tokens. No client secret ships in the NPM package.

The default API origin is `https://api.airforce`, defined once in `src/auth/constants.ts`. A base URL can include `/v1`; endpoint construction avoids duplicating it. Custom endpoints remain configurable. HTTPS is required except for loopback test endpoints. Redirects are rejected so credentials are not forwarded to another origin.

```sh
airforce auth                 # choose API key or OAuth
airforce auth api-key         # securely replace the saved API key
airforce auth oauth           # sign in again with OAuth
airforce auth status          # show credential type/source, never the secret
airforce login                # alias for: airforce auth oauth
airforce login --no-browser   # print the OAuth URL for manual opening
airforce logout               # revoke OAuth when applicable and clear saved credentials
```

The interactive `/auth` command provides the same method picker; `/auth api-key` and `/auth oauth` select a method directly. Replacement credentials are checked with `/v1/models` before Airforce overwrites the current saved credential. If validation fails, the existing credential remains available.

OAuth tokens last up to 24 hours and the provider does not issue refresh tokens yet, so Airforce asks you to sign in again after expiry. The default scopes are `profile chat`; add `images` to `oauthScopes` and reauthenticate if the image tool is required. Saved OAuth tokens use the same private, unencrypted credential file as saved API keys. `AIRFORCE_API_KEY` takes precedence over saved OAuth credentials.

The explicit `airforce login` and `airforce auth` commands save the validated replacement. During first-run onboarding, you can decline persistence and use the credential only for that running session.

Use environment variables instead of saving credentials:

```sh
export AIRFORCE_BASE_URL='https://your-api-endpoint.example'
export AIRFORCE_API_KEY='your-key'
export AIRFORCE_MODEL='model-id-returned-by-your-api'
airforce models
airforce
```

These are illustrative override values, not a real model list. Avoid putting keys into shell history on shared machines. API keys are never accepted in project configuration.

The optional `credentials.json` file is **unencrypted**, owner-only on POSIX. Use environment injection on shared hosts. Native keychain integration is deferred. Windows users must rely on appropriate user-profile directory ACLs; POSIX mode bits do not enforce Windows ACLs.

## Directory consent

Before the first interactive session in a project, Airforce Code shows the canonical project root and explains what the selected permission mode allows. You can trust that exact directory, continue once, or exit before repository inspection begins. Trust is stored outside the repository in a private user file.

```sh
airforce directories list
airforce directories trust ./project
airforce directories revoke ./project
airforce --cwd ./project --trust-directory
```

Explicit headless runs such as `airforce -p ...` are treated as consent for that invocation. They do not persist directory trust unless `--trust-directory` is supplied.

## Everyday work

```text
❯ Fix the login tests.
  › Finding files: login
  ✓ search_files
  › Reading src/login.ts
  ✓ read_file
  › Running the targeted tests
  [exact executable and argument approval]
```

The agent can make multiple provider and tool calls per task. Tool results return to the model for the next step; failures are data the agent can reason about. The core system prompt requires accurate verification reporting, but test success is never inferred by the application merely from a successful file write.

The workspace uses a responsive Airforce Code wordmark, a compact project/model/mode status card, accessible scrollback, readable tool boundaries, command history, and live command discovery. The framed input shows a quiet placeholder while empty. Type `/` to open every slash command, continue typing to filter by name or purpose, use ↑/↓ or Page Up/Page Down to scroll through the complete list, and press Tab or Enter to complete. The palette sizes itself to the terminal instead of overflowing it. Ctrl+J inserts a new line. Ctrl+C clears current input; press it again at an empty prompt to exit.

During a request, an animated `Working · 3s` status shows elapsed time and changes its label when a tool starts. It pauses cleanly for streamed answers, tool summaries, errors, and approval prompts. Escape or Ctrl+C cancels active model and tool work. Assistant responses render terminal-friendly Markdown, including headings, lists, tables, links, blockquotes, inline code, and syntax-highlighted fenced code. Output is streamed at complete Markdown block boundaries to prevent broken tables, partial code fences, split credentials, and terminal escapes from reaching the display.

Errors display stable identifiers such as `[CONFIG]`, `[PERMISSION]`, `[COMMAND_FAILED]`, or `[COMMAND_TIMEOUT]`. JSON and JSONL output expose the same codes as fields so scripts can distinguish failure classes without parsing prose.

## Permissions

| Mode | Reads     | Repository text edits | Executable code / Git writes / MCP | Deletion and privileged operations |
| ---- | --------- | --------------------- | ---------------------------------- | ---------------------------------- |
| Ask  | Automatic | Ask                   | Ask                                | Ask                                |
| Edit | Automatic | Automatic             | Ask                                | Ask                                |
| Auto | Automatic | Automatic             | Ask unless explicitly allowlisted  | Ask                                |

**Airforce does not provide an OS sandbox.** A test runner, build script, Git hook, or MCP process may access anything your user account can access. Auto intentionally retains execution approval until a sandbox backend exists. No shell string interpolation is used: commands are executable/argument arrays. An approved `sh -c`, Python script, or other interpreter still has its normal capabilities.

Non-interactive mode denies approval requests. Denials are returned to the agent, which may still complete useful read-only work. Exact argv allowlists in **user** config can authorize CI commands:

```sh
airforce config set allowedCommands '[["npm","run","test"]]'
airforce -p 'Run the tests and fix failures' --permission-mode edit --json
```

An allowlist approves the code those commands run, including project scripts. It does not sandbox them. Appended arguments do not match. High-risk classifications and deny rules take precedence; hooks and MCP do not inherit command allowlist privileges.

`deniedCommands` contains command-line prefixes; `deniedPaths` contains project-relative path prefixes. Protected credential paths, `.git`, Airforce session storage, symlinks, hard-linked files, outside-root paths and special files are denied by the built-in file layer. Policies apply to tools in application code, independent of model instructions. Optional image networking is disabled unless `network` is true; ordinary configured LLM requests do not use this optional-tool setting.

## Configuration

```sh
airforce config
airforce config set permissionMode edit
airforce config set protocol anthropic
airforce config set contextTokens 64000
```

`/config` offers ordinary settings interactively, including the authentication picker. Saved settings take effect on restart; `/model`, `/permissions`, and `/auth` change the running session immediately. Configuration is validated and unknown keys produce errors.

Precedence: CLI flags → environment → restricted project config → user config → defaults. Environment settings: `AIRFORCE_API_KEY`, `AIRFORCE_BASE_URL`, `AIRFORCE_MODEL`, `AIRFORCE_PERMISSION_MODE`, `AIRFORCE_PROTOCOL`, `AIRFORCE_HOME`.

User data locations:

- Linux: `$XDG_CONFIG_HOME/airforce`, otherwise `~/.config/airforce`.
- macOS: `~/Library/Application Support/Airforce`.
- Windows: `%LOCALAPPDATA%/Airforce`.
- Override: an absolute `AIRFORCE_HOME`.

User `config.json` can configure endpoint, model, protocol, modes, context/output limits, temperature, turn limit, denied paths/commands, exact allowed commands, optional network access, MCP servers, and hooks. Secrets live separately. To prevent repository-driven key exfiltration or execution, project `.airforce.json` accepts **only** `model` and `contextTokens`.

## Models and protocols

`airforce models`, `/model`, and `/model refresh` use `/v1/models`. There is no baked-in catalog. The interactive picker filters as you type by model name or ID, keeps current/recent models easy to reach, and shows input/output USD prices per million tokens alongside tool and context metadata when the API supplies them. Discovery is cached for five minutes in memory.

The API reports token prices as integer cents per million in `pricepermilliontokens` and `output_pricepermilliontokens`. Airforce normalizes these to USD, records provider-reported input/output usage in the session, and displays the running estimated session cost in the workspace, prompt footer, `/status`, resume picker, and after each completed request. Older sessions and models without pricing show `price unavailable`. The estimate currently applies ordinary input/output rates; provider settlement may differ when cache discounts or other adjustments apply.

OpenAI chat completions and Anthropic messages normalize to the same internal messages and events. Tool arguments are assembled completely before execution. Incomplete streams do not execute partially received tools. Transient HTTP errors retry before consuming the response; the agent does not silently replay a partially consumed completion. Capability metadata is used when supplied; unknown capability support remains unknown. Models explicitly marked without tools receive no tools. Unsupported protocol features produce actionable errors rather than textual tool-call guessing.

## Project instructions and context

Recognized instruction files: `AIRFORCE.md`, `AGENTS.md`, `CLAUDE.md`. Within a directory their precedence follows that order. Closer directories override parent guidance **for files in their scope**; explicit user requirements and security policy always win. Nested instructions are loaded lazily as files are read. `/instructions` shows root guidance; nested guidance also enters scoped model context as accessed files are considered. Parent directories outside the project root are not loaded.

`/init` asks the agent to inspect the repository and create a short, useful `AIRFORCE.md` through the ordinary guarded editing workflow. It is not a fixed boilerplate generator.

The startup map is shallow. Search is lazy, bounded and respects nested `.gitignore` rules, dependency/build exclusions and credential paths. Read ranges include a full-file SHA256. Regex search runs in a terminable worker, with a 500 ms budget. There is no embedding database.

`/compact` summarizes task history through the selected provider while keeping the full transcript on disk and all user requirements verbatim in active context. It can incur API usage. Automatic compaction uses conservative byte-based estimates; these are not exact tokenizer counts. Oversized requirements produce a context error instead of silently dropping them. Summaries are model-generated and may be imperfect; the retained transcript is the audit source.

## Question-first mode

```text
/question
/question Build a plugin system.
/question off
```

Mode persists in the session. While enabled, non-read tools are blocked even in Auto. Airforce can inspect context and ask focused questions. Explicitly use `/question off` when ready to implement. `--question` provides the same behavior for headless requests.

## Sessions, edits and Git

```sh
airforce resume                    # searchable picker for this project
airforce resume SESSION_UUID
airforce --resume
airforce --resume SESSION_UUID
airforce --continue                # immediately use the most recent session
airforce sessions list
airforce sessions show SESSION_UUID
airforce sessions rename SESSION_UUID 'Authentication fix'
airforce sessions fork SESSION_UUID
airforce sessions delete SESSION_UUID
```

Sessions are private versioned JSON with atomic saves, concurrent task locks, tool history, durable requirements, provider-reported token usage, running estimated cost, and tracked text snapshots. `airforce resume` and bare `--resume` open a searchable project-scoped picker with title, recency, message count, tokens, cost, and short ID; `--continue` skips the picker and selects the latest session. Resume requires the same project root. Forks preserve conversation and usage but drop undo ownership. Sessions may contain source code and prompts after best-effort redaction: keep the data directory private. Unknown future schemas fail with recovery guidance; defaults migrate added fields in version 1.

Edits require a matching SHA256. Patches replace one unique exact span; no fuzzy patching. A write-ahead record helps inspect interrupted mutations. `/undo` and `/redo` compare current bytes before restoring a tracked file. They never call `git reset --hard`. Move is a tracked copy followed by tracked deletion, so an interruption can leave both paths. External command changes and generated binary assets are not covered by text undo.

`/git`, `/diff`, `/review` and `/branch` support Git workflows. Diff output suppresses known credential paths and external diff/textconv helpers. `/commit` asks the model to summarize tracked changes and propose a message before its approval-gated commit tool runs. The tool requires an empty initial index and refuses files that had pre-existing user changes. Git hooks and filters can execute after approval. Failed commits may leave the selected files staged. Arbitrary concurrent modifications to the Git index are not transactionally isolated.

## Slash commands

| Commands                                                   | Purpose                                       |
| ---------------------------------------------------------- | --------------------------------------------- |
| `/help`, `/status`, `/doctor`, `/exit`                     | Help, state, diagnostics, clean exit          |
| `/auth [api-key\|oauth]`                                   | Replace API key or reauthenticate with OAuth  |
| `/model [refresh\|id]`, `/permissions [mode]`, `/config`   | Model and settings                            |
| `/init`, `/instructions`, `/files`, `/context`, `/compact` | Repository context                            |
| `/question [off\|request]`, `/review [target]`             | Clarification-first work and read-only review |
| `/git`, `/diff`, `/branch [name]`, `/commit`               | Git workflows                                 |
| `/undo`, `/redo`                                           | Checked text-edit restoration                 |
| `/sessions`, `/resume [id]`, `/new`, `/history`, `/export` | Session lifecycle                             |
| `/tools`, `/mcp [connect name]`, `/hooks`                  | Tool and extension inspection                 |
| `/clear`                                                   | Clear display, retain conversation            |

Commands not listed here are not implemented. `/feedback` is deferred; no hidden upload happens.

## Automation

```sh
git diff | airforce -p 'Review this patch' --json
airforce -p 'Explain the architecture' --jsonl --cwd ./project
airforce -p 'Update the README' --permission-mode edit --quiet
airforce -p 'Summarize the changes' --output summary.txt
```

`--json` emits one result object, `--jsonl` emits typed events. Neither contains decorative output. Piped input is labeled untrusted and bounded to 1 MB. `--output` writes a **new** file, refusing to overwrite an existing file. `--quiet` suppresses action summaries. `NO_COLOR` and `--no-color` are respected.

Exit codes: `0` completed, `1` runtime/provider error, `2` configuration/usage, `3` approval denied, `4` turn budget reached, `130` cancellation. A completed model response may still report unresolved engineering work; exit 0 is not a guarantee of test success. Tool errors remain visible in JSONL/session history.

## MCP and hooks

```sh
airforce mcp add local-tools node /absolute/path/server.js
airforce mcp enable local-tools
airforce mcp list
# In the interactive session:
/mcp connect local-tools
/tools
```

Stdio MCP uses the official SDK. Adding/enabling a server does not start it. Connection asks for execution approval and tools ask separately. Server descriptions, schemas and results are untrusted; responses pass through redaction and output limits. MCP starts with a small environment and no Airforce credentials. It still has user-level OS access. Only globally configured stdio servers are currently supported. Directory consent covers the local project; per-project MCP server configuration and HTTP MCP transports are deferred.

Hooks are explicit user-configured argv arrays. Events: `before_tool`, `after_tool`, `before_write`, `after_write`, `before_command`, `after_command`. Optional `tool` filters scope a hook. Every hook execution asks independently; failed before-hooks stop the tool, failed after-hooks report failure even though the tool may already have changed state. Session lifecycle hooks are deferred.

```sh
airforce config set hooks '[{"event":"after_write","tool":"patch_file","command":"npm","args":["run","lint"]}]'
```

## Images and future integrations

The `generate_image` tool calls `/v1/images/generations`, requests one base64 PNG, validates its signature, and creates a new `.png` under repository write permissions. Set `network` true to enable it. Remote result URLs, non-PNG media, generated-asset undo and real endpoint validation are deferred. Separate extension interfaces define web search, GitHub, media and stronger executor backends. No web or GitHub integration is advertised as connected today.

## Troubleshooting and security

Run `airforce doctor`. Check the endpoint, API key and model with `airforce models`. HTTP errors explain authentication, rate limits, missing models and malformed/incomplete streams. If a file changed, re-read and rebase rather than retrying the stale patch. If a session is corrupt, preserve it for recovery and start a new one. Remove a stale `.lock` only after confirming no Airforce process owns the session.

No telemetry, prompt uploads for analytics, automatic updates, or feedback reporting are implemented. Your requested provider calls necessarily send selected context to the configured endpoint. Read [SECURITY.md](SECURITY.md) for the threat model and known limitations, [architecture](docs/ARCHITECTURE.md) for module boundaries, and [CONTRIBUTING.md](CONTRIBUTING.md) for tests and releases.
