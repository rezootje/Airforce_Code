# Airforce implementation roadmap

## Inspection

The initial workspace contains no source, manifests, or repository instructions. Its mounted `.git` is not a usable Git checkout. There is no existing architecture to preserve. Do not initialize or overwrite the mounted metadata.

## Sequence

1. Runnable TypeScript/ESM NPM package; configuration and private persistence.
2. Normalized provider API, bounded SSE streaming, model discovery, onboarding and model search.
3. Headless event-driven multi-step agent; repository read/search tools; persisted sessions.
4. Application-enforced permissions, guarded paths, optimistic edits, undo, cancellable processes, Git.
5. Repository map, instruction precedence, context budgeting/compaction, question-first mode.
6. Interactive/slash and automation interfaces; MCP through explicit approval boundaries.
7. Adversarial/integration/CLI tests, package installation checks, CI and release documentation.

## Decisions and risks

- Node 24+, ESM, TypeScript strict; Zod validates configuration and tool inputs.
- Evaluate Ink: useful for full-screen rich interfaces, but initial UI uses Inquirer and readline for accessible scrollback, native selection/password prompts, streaming and low startup cost. UI consumes core events; Ink can replace the view later.
- No guessed production API hostname. Setup requires an explicit base URL. Both wire protocols share one normalized agent loop.
- API keys come from environment or a separate owner-only credential file, never project config. This is not an encrypted OS keychain.
- Arbitrary programs and MCP processes are not a sandbox. They always need explicit approval; Auto permits safe repository file edits, not arbitrary executable code. OS sandbox backends remain an extension point.
- Guard symlinks, traversal, credential paths, stale edits and terminal escapes. Pure Node path checks cannot promise race-free isolation against a concurrent hostile local process.
- Context compaction must preserve verbatim user requirements and tool-message integrity; fail explicitly if those alone exceed the budget.
- No paid API tests in ordinary CI. Real compatibility depends on endpoint/model capabilities and needs opt-in validation.
- Ship only functioning commands; document incomplete production specification items and release gates, never success-shaped stubs.

## Implementation progress

The initial vertical slice is implemented and covered by mocked API/CLI tests. Repository tools, execution policy, sessions, compaction, Git, MCP, hooks and the PNG adapter have been added. The package remains runnable after typecheck/build milestones. See STATUS for the exact implemented scope and remaining release gates; it supersedes aspirational feature expectations in the original sequence.
