# OpenCode 1.17.19+ Compatibility Design

## Context

Manual Video Studio currently requires exactly OpenCode 1.4.1 and resolves the first native `opencode.exe` found on `PATH`. That works on the original development PC because Bun exposes OpenCode 1.4.1 first, but it fails on another Windows PC when a compatible npm installation is exposed through `opencode.cmd` or when an older native executable precedes a newer compatible package.

OpenCode 1.17.19 and 1.18.2 both ship a native Windows executable at `opencode-ai/bin/opencode.exe`. The Studio must accept stable OpenCode versions greater than or equal to 1.17.19 without weakening its existing fail-closed executable, configuration, permission, MCP, session, and event contracts.

## Goals

- Accept stable OpenCode versions `>=1.17.19`.
- Reuse a compatible existing Windows installation even when an older executable appears first on `PATH`.
- Never execute `.cmd`, `.ps1`, extensionless shims, or shell-composed commands.
- Install an exact project-owned OpenCode 1.18.2 fallback only when no compatible installation exists.
- Bind the selected executable path and exact selected version through bootstrap, doctor, runtime construction, preflight, server health, and job execution.
- Keep later OpenCode versions fail-closed when their resolved config, agents, tool inventory, MCP contract, permissions, sessions, or event stream no longer match the validated contract.
- Prove the compatibility floor with OpenCode 1.17.19 and the current fallback with OpenCode 1.18.2.

## Non-goals

- Running OpenCode through an npm command shim or `cmd.exe`.
- Silently accepting prerelease, malformed, or unparseable version strings.
- Disabling live OpenCode contract validation to accommodate a newer version.
- Automatically upgrading a compatible user installation.
- Changing the approved Playwright MCP, Supertonic, HyperFrames, or FFmpeg versions.

## Considered approaches

### 1. Change only the version comparison

Replacing `1.4.1` equality with `>=1.17.19` is small, but it still selects the first native executable on `PATH`. An older Bun executable would continue to mask a compatible npm package. This does not solve the reported company-PC failure.

### 2. Always install and use project OpenCode 1.18.2

This is deterministic but ignores a compatible 1.17.19-or-newer installation and performs an unnecessary large download on every fresh checkout. It also does not meet the requested reusable-version behavior.

### 3. Discover compatible native candidates with a project fallback

This approved design reuses a safe compatible installation, skips incompatible candidates, and installs an exact project-owned fallback only when required. It preserves direct native process spawning and the existing live contract gates.

## Architecture

### Shared OpenCode installation resolver

A new JavaScript module owns stable-version parsing, comparison, native executable inspection, npm package manifest validation, candidate discovery, and bounded `--version` probing. Bootstrap, doctor, and the production runtime use this shared logic through a small JSON command-line wrapper so PowerShell and Node cannot drift into different selection rules.

Every accepted executable must be:

- an absolute canonical `.exe` path;
- a regular file rather than a symlink or reparse point;
- invoked with `shell: false` and an argument array;
- responsive to a bounded `--version` probe;
- a stable semantic version greater than or equal to 1.17.19.

For npm-derived candidates, the resolver also requires an `opencode-ai` package manifest whose version and `bin.opencode` entry match the canonical native executable and whose declared version equals the executable's reported version.

### Candidate order

1. `MANUAL_STUDIO_OPENCODE_PATH`, when explicitly supplied. An unsafe or incompatible override is a terminal configuration error and never falls through silently.
2. The project-owned fallback at `.runtime/opencode/node_modules/opencode-ai/bin/opencode.exe`, if already installed.
3. Every bounded native `opencode.exe` result returned by `where.exe`, skipping safe but too-old versions.
4. Native npm package targets derived from bounded `opencode.cmd` locations. The shim is never read as code or executed; only the standard sibling package manifest and native binary are inspected.
5. If no compatible candidate exists during prepare mode, install exact `opencode-ai@1.18.2` under `.runtime/opencode`, then resolve and verify it again.

Check mode never installs or modifies a runtime. It reports the minimum, actual selected version, selected native path, and readiness.

### Exact-version binding

The resolver returns an immutable `{ path, version, source }` selection. The production runtime passes the exact selected version into `OpenCodeServer` instead of relying on a global constant.

Before server launch, the executable's `--version` output must still equal the selected version. After launch, the OpenCode health endpoint must report that same version. Existing resolved configuration, agent prompt, permission, MCP capability, tool inventory, and session checks remain mandatory. OpenCode JSON events continue to be parsed against a bounded allowlist; unknown event envelopes remain terminal.

This means a future version satisfies the numeric floor only provisionally. It runs only when all behavioral contracts still match.

## Bootstrap and startup flow

`start.ps1` invokes the shared resolver in prepare mode while preparing the other pinned engines. A compatible existing OpenCode causes no install. If fallback installation is required, npm receives fixed argument-array inputs and installs only inside the project-owned runtime directory.

The selected canonical path and exact version are then passed into the Node service through dedicated environment values. Runtime construction revalidates the selection rather than trusting bootstrap output. `doctor` uses check mode and reports the same selection without installing anything.

## Error handling

- `1.17.18` and older: `OPENCODE_VERSION_UNSUPPORTED`.
- Malformed or prerelease version: `OPENCODE_VERSION_INVALID`.
- Unsafe explicit override: existing unsafe executable configuration failure.
- No compatible candidate in check mode: not ready with minimum-version detail.
- Project fallback installation failure: bounded preparation failure without selecting a partial install.
- Manifest, executable, or selected-version mismatch: fail closed before server launch.
- CLI, health, config, agent, permission, MCP, tool, session, or event contract drift: retain the existing safe OpenCode contract failure path.

Errors expose only safe codes and version/path metadata already suitable for local diagnostics. They never include environment secrets, credentials, MCP capability tokens, or raw model output.

## Testing strategy

TDD coverage will prove:

- stable semantic comparison rejects 1.17.18 and accepts 1.17.19, 1.18.2, and a later stable version;
- prereleases and malformed versions are rejected;
- a PATH-first 1.4.1 executable is skipped for a later npm-native 1.18.2 candidate;
- `.cmd`, relative, symlinked, reparsed, manifest-mismatched, and executable-version-mismatched candidates are rejected;
- an invalid explicit override never silently falls back;
- a compatible candidate causes zero fallback installation calls;
- missing candidates cause one exact project-local 1.18.2 installation in prepare mode and no installation in check mode;
- runtime, preflight, and server health bind to the exact selected version;
- actual isolated OpenCode 1.17.19 and 1.18.2 resolve the Studio config and both agents with the approved permission and MCP contracts;
- representative JSON event streams from both versions normalize identically, while an unknown future event remains fail-closed;
- all existing browser, media, restart-recovery, API, UI, and artifact tests remain green.

## Acceptance criteria

- On the current PC, the resolver skips Bun OpenCode 1.4.1 and selects the installed npm-native OpenCode 1.18.2.
- On an isolated fixture containing only OpenCode 1.17.19, doctor and the real OpenCode configuration tests pass.
- On a fixture containing only 1.17.18, startup reports an unsupported-version failure.
- A company PC with any contract-compatible stable OpenCode version at or above 1.17.19 can start the Studio without downgrading it.
- A company PC without a compatible installation receives the exact project-owned 1.18.2 fallback.
- Full verification and a real browser-driven Manual Video Studio workflow complete without weakening the existing safety gates.
