# Contributing to Loop

Thank you for your interest in contributing to Loop! Whether you're fixing a bug, improving security, adding an agent importer, or refining the dashboard, we appreciate your help.

## Prerequisites

- **Node.js 22.13+**
- Local Loop runs with zero configuration using local password authentication. A free [Clerk](https://clerk.com) publishable key is only needed when testing hosted multi-user mode (`LOOP_HOSTED=1`), and is not required for local development or running the test suite.

## Local Development Setup

```sh
git clone https://github.com/mattsegura/loop.git
cd loop
npm install
npm start
```

To test hosted multi-user mode locally, copy `.env.example` to `.env.local` and set `LOOP_HOSTED=1` and `CLERK_PUBLISHABLE_KEY`.

Open **http://127.0.0.1:8799/**.

## Running Tests

Loop uses Node's built-in test runner (`node:test`) with zero external test frameworks:

```sh
# Main unit, integration, and E2E test suite
npm test

# Security audit regression suite (runs in isolated temp sandboxes, ~1 min)
npm run test:audit
```

Both suites must pass before a pull request can be merged.

## Architecture Overview

Loop is a lightweight, zero-build ESM Node.js application:

- `server.mjs` — HTTP API server, `/mcp` gateway router, SSE/OAuth endpoints, and workspace routing.
- `stdio.mjs` — Local `stdio` bridge for MCP clients that do not speak HTTP natively.
- `lib/` — Core modules:
  - `mcp-server.mjs` & `mcp-client.mjs` — MCP gateway tools (`loop__search`, `loop__inspect`, `loop__run`, `loop__save`) and upstream client pool.
  - `vault.mjs` & `secret-refs.mjs` — AES-256-GCM encrypted credential store and `{{vault:KEY}}` placeholder resolution/redaction.
  - `policies.mjs`, `security.mjs`, `outbound-policy.mjs` — Approval rules, request guards, and SSRF/origin protections.
  - `oauth.mjs`, `mcp-oauth.mjs`, `clerk-app.mjs` — Upstream OAuth 2.1, agent OAuth 2.1 consent, and Clerk session verification.
  - `store.mjs`, `profiles.mjs`, `agents.mjs`, `skills.mjs`, `memory.mjs` — Workspace config, profiles, agents, skills, and shared memory.
  - `importers.mjs` & `agent-hooks.mjs` — Local agent discovery/import and hook management.
- `public/` — Vanilla HTML/CSS/JS web dashboard (no build step required).
- `hooks/` & `skills/` — Built-in agent hooks and Loop skills.
- `test/` — Unit, integration, E2E, and security audit regression tests.

## Pull Request Guidelines

1. **Keep PRs focused.** One feature, fix, or refactor per PR makes review faster and safer.
2. **Write tests alongside code.** Add or update tests in `test/` covering both happy paths and edge/error cases.
3. **Respect security boundaries.** Never expose raw Vault values to agents, logs, errors, or config exports. If your change touches auth, OAuth, Vault, approvals, or outbound networking, double-check `npm run test:audit`.
4. **Match existing style.** Loop uses native ESM (`.mjs`), minimal dependencies, and plain browser JS in `public/`. Avoid adding new runtime dependencies unless there is a strong reason.

## Reporting Security Issues

**Do not open a public issue or pull request for security vulnerabilities.** Please follow the private disclosure process in [SECURITY.md](SECURITY.md).

## License & Contributor Agreement

Loop is released under [AGPL-3.0-only](LICENSE) and is also offered under commercial licenses. Before a pull request can be merged, outside contributors must sign the [Contributor License Agreement](CLA.md).

When you open a pull request on GitHub, the automated CLA check will prompt you to sign by posting:

```text
I have read the CLA Document and I hereby sign the CLA
```
