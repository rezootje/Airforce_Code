# Contributing

Use Node 24+ and NPM. Keep provider, agent, permission, persistence and UI code separate. Read [architecture](docs/ARCHITECTURE.md) and [security](SECURITY.md) before changing execution or data boundaries.

```sh
npm ci
npm run dev -- --help
npm run check
npm run format:check
npm run test:package
```

`check` runs typecheck, lint, tests and build. Tests use temporary repositories, fake providers and loopback HTTP fixtures; no paid key is needed. CLI integration tests spawn processes and bind a loopback server, so restrictive execution sandboxes may need explicit access. Do not weaken production checks to accommodate a sandbox fixture.

## Changes

- Use strict types and boundary schemas. Do not add textual pseudo-tool fallbacks.
- Register tools via `ToolRegistry`; every side effect must have a policy decision.
- Prefer argv arrays and the injected executor; never interpolate model strings into shell code.
- Keep source data labeled untrusted and redact before display, persistence and provider requests.
- Test failures and denials, not only happy paths. Include a regression for each security fix.
- Keep tool writes optimistic and auditable. Never implement undo through blanket Git reset.
- Describe intentional limits in README and STATUS. Do not expose success-shaped placeholders.
- Update the changelog for user-visible changes. No repository contact or package ownership should be invented.

## Provider compatibility harness

Explicitly opt in to potentially billable API requests:

```sh
AIRFORCE_API_TEST=1 npm run test:api
AIRFORCE_API_TEST=1 AIRFORCE_PROTOCOL=anthropic npm run test:api
```

Supply `AIRFORCE_API_KEY`, `AIRFORCE_BASE_URL`, and a discovered `AIRFORCE_MODEL` using secure environment injection. The harness checks discovery, completion/streaming and tool calls. It sends synthetic prompts, not repository source. Run separately for protocols/models supported by the account. Standard CI never sets this opt-in variable. Real image generation should be manually checked on a disposable asset project after enabling optional network access.

## Release

1. Complete the gates in STATUS and establish package ownership/security reporting.
2. Confirm ownership of the `airforce-code` NPM package and preserve both executable aliases.
3. Configure NPM trusted publishing for this repository's release workflow, and protect the `npm-release` GitHub environment. No long-lived publishing token is in this repository.
4. Update CHANGELOG and use `npm version patch|minor|major` in a real Git checkout. Follow SemVer; do not reuse versions.
5. Run all checks, audit runtime dependencies, and install the generated tarball in a clean temporary prefix.
6. Push the matching `vX.Y.Z` tag only when release is authorized. The release workflow verifies the tag/changelog, checks and installs the package, then publishes with provenance.

The supplied workspace initially had an unusable mounted `.git`; implementation did not replace it. Create or use a real Git checkout to run Git release operations. Creating files for a release workflow does not publish anything.
