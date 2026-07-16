# OpenCode 1.17.19+ Compatibility Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Manual Video Studio safely reuse any contract-compatible stable OpenCode version at or above 1.17.19 and install a project-owned 1.18.2 fallback only when required.

**Architecture:** Introduce one JavaScript OpenCode installation resolver shared by bootstrap, doctor, and production runtime. It selects only canonical native Windows executables, binds the exact selected version through OpenCode server preflight and health, and preserves all existing config, agent, permission, MCP, session, and event fail-closed checks.

**Tech Stack:** Node.js ESM, Windows PowerShell, node:test, native OpenCode CLI 1.17.19/1.18.2, npm, existing Manual Video Studio runtime adapters.

---

### Task 1: Add stable OpenCode version semantics

**Files:**
- Create: src/runtime/opencode-installation.js
- Create: test/runtime/opencode-installation.test.js
- Modify: src/config.js:5-13
- Modify: test/preflight.test.js

**Step 1: Write the failing version tests**

Add tests for this wished-for API:

~~~js
import {
  OPEN_CODE_FALLBACK_VERSION,
  OPEN_CODE_MINIMUM_VERSION,
  parseStableOpenCodeVersion,
  supportsOpenCodeVersion,
} from "../../src/runtime/opencode-installation.js";

test("the OpenCode compatibility floor is inclusive and stable-only", () => {
  assert.equal(OPEN_CODE_MINIMUM_VERSION, "1.17.19");
  assert.equal(OPEN_CODE_FALLBACK_VERSION, "1.18.2");
  assert.equal(supportsOpenCodeVersion("1.17.18"), false);
  assert.equal(supportsOpenCodeVersion("1.17.19"), true);
  assert.equal(supportsOpenCodeVersion("1.18.2"), true);
  assert.equal(supportsOpenCodeVersion("2.0.0"), true);
  for (const value of ["1.18", "v1.18.2", "1.18.2-beta.1", "01.18.2"]) {
    assert.equal(parseStableOpenCodeVersion(value), null);
  }
});
~~~

Update preflight expectations from exact OpenCode 1.4.1 to minimum 1.17.19 and fallback 1.18.2.

**Step 2: Run the focused test and verify RED**

~~~powershell
node --test test/runtime/opencode-installation.test.js test/preflight.test.js
~~~

Expected: FAIL because the resolver module and minimum/fallback constants do not exist.

**Step 3: Implement the minimal version API**

Implement a strict major.minor.patch parser using safe integers and component-wise comparison. Export immutable minimum and fallback constants and update VERSION_PINS to distinguish minimum from fallback. Do not add a semver dependency or accept prerelease/build metadata.

**Step 4: Run the focused tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

**Step 5: Commit**

~~~powershell
git add src/config.js src/runtime/opencode-installation.js test/runtime/opencode-installation.test.js test/preflight.test.js
git commit -m "feat: define OpenCode compatibility floor"
~~~

### Task 2: Resolve safe compatible native candidates

**Files:**
- Modify: src/runtime/opencode-installation.js
- Modify: test/runtime/opencode-installation.test.js

**Step 1: Write failing candidate tests**

Use temporary real files and dependency-injected runWhere and runVersion functions to prove:

- an explicit canonical .exe override is selected only when it is at least 1.17.19;
- an explicit old or unsafe override fails without fallback;
- a PATH-first 1.4.1 executable is skipped for a later safe 1.18.2 executable;
- .cmd, relative, symlinked, and reparse-point candidates are rejected;
- timeouts, oversized output, nonzero exits, malformed versions, and duplicates fail closed;
- all probes use shell false, exact --version argv, bounded time/output, and sanitized environment.

Desired immutable result:

~~~js
assert.deepEqual(selection, {
  path: await realpath(newerExe),
  source: "path",
  version: "1.18.2",
});
assert.equal(Object.isFrozen(selection), true);
~~~

**Step 2: Run and verify RED**

~~~powershell
node --test test/runtime/opencode-installation.test.js
~~~

Expected: FAIL because candidate discovery and version-aware selection are absent.

**Step 3: Implement candidate discovery**

Reuse the executable safety rules in src/runtime.js: absolute canonical path, .exe extension, regular file, no link/reparse drift, and direct process execution. Never choose a candidate before probing its version.

**Step 4: Run and verify GREEN**

Run the command from Step 2. Expected: PASS.

**Step 5: Commit**

~~~powershell
git add src/runtime/opencode-installation.js test/runtime/opencode-installation.test.js
git commit -m "feat: select compatible OpenCode executables"
~~~

### Task 3: Resolve npm-native candidates and project fallback

**Files:**
- Modify: src/runtime/opencode-installation.js
- Modify: test/runtime/opencode-installation.test.js
- Create: scripts/opencode-runtime.mjs
- Create: test/operational/opencode-runtime-script.test.js

**Step 1: Write failing npm and fallback tests**

Prove:

- a discovered opencode.cmd is never executed;
- only a sibling node_modules/opencode-ai/package.json with the correct name, stable compatible version, and bin.opencode path is accepted;
- manifest version and canonical binary must match --version output;
- existing .runtime/opencode precedes user-global candidates;
- check mode reports not ready and never installs;
- prepare mode invokes one exact opencode-ai@1.18.2 project-prefix install only when no compatible candidate exists;
- partial or mismatched fallback installation is rejected.

Specify the JSON-only wrapper result:

~~~json
{
  "ready": true,
  "minimum": "1.17.19",
  "fallback": "1.18.2",
  "path": "C:\\safe\\opencode.exe",
  "source": "npm-global",
  "version": "1.18.2"
}
~~~

**Step 2: Run and verify RED**

~~~powershell
node --test test/runtime/opencode-installation.test.js test/operational/opencode-runtime-script.test.js
~~~

Expected: FAIL because npm discovery, fallback installation, and the wrapper do not exist.

**Step 3: Implement npm discovery and wrapper**

The wrapper accepts only check or prepare mode plus bounded Studio/runtime roots. Use fixed npm argv with shell false. Install into a staging directory and atomically publish the project fallback so an interrupted install is never ready.

**Step 4: Run and verify GREEN**

Run the command from Step 2. Expected: PASS.

**Step 5: Commit**

~~~powershell
git add src/runtime/opencode-installation.js scripts/opencode-runtime.mjs test/runtime/opencode-installation.test.js test/operational/opencode-runtime-script.test.js
git commit -m "feat: add project OpenCode fallback"
~~~

### Task 4: Wire the resolver into bootstrap, doctor, and startup

**Files:**
- Modify: scripts/bootstrap.ps1:19-277
- Modify: scripts/start.ps1
- Modify: scripts/doctor.mjs
- Modify: src/preflight.js
- Modify: test/operational/scripts.test.js
- Modify: test/runtime-start.test.js
- Modify: test/preflight.test.js

**Step 1: Write failing operational tests**

Require the scripts to:

- report minimum 1.17.19 and actual selected version instead of exact equality with 1.4.1;
- invoke scripts/opencode-runtime.mjs in check or prepare mode;
- remove global opencode-ai@1.4.1 installation;
- set MANUAL_STUDIO_OPENCODE_PATH and MANUAL_STUDIO_OPENCODE_VERSION from one validated result;
- preserve no-install Check and WhatIf behavior;
- reject malformed, missing, or mismatched resolver JSON;
- keep secrets out of child environments and logs.

**Step 2: Run and verify RED**

~~~powershell
node --test test/operational/scripts.test.js test/runtime-start.test.js test/preflight.test.js
~~~

Expected: FAIL against the current exact 1.4.1 bootstrap.

**Step 3: Implement the wiring**

Replace independent PowerShell OpenCode discovery with the shared wrapper. Pass the exact selection to Node in memory and never persist a machine-specific path in source or job data. Doctor should report expected >=1.17.19, actual version, and readiness.

**Step 4: Run and verify GREEN**

Run the command from Step 2. Expected: PASS.

**Step 5: Commit**

~~~powershell
git add scripts/bootstrap.ps1 scripts/start.ps1 scripts/doctor.mjs src/preflight.js test/operational/scripts.test.js test/runtime-start.test.js test/preflight.test.js
git commit -m "feat: bootstrap compatible OpenCode runtime"
~~~

### Task 5: Bind exact selected version through runtime and server

**Files:**
- Modify: src/runtime.js:320-362
- Modify: src/adapters/opencode-server.js
- Modify: src/index.js
- Modify: test/runtime.test.js
- Modify: test/adapters/opencode-server.test.js
- Modify: test/runtime-start.test.js

**Step 1: Write failing runtime/server tests**

Specify that:

- production runtime receives exact path and version;
- OpenCodeServer requires a supported expectedVersion;
- executable preflight and the health endpoint must equal that exact version;
- 1.17.19 and 1.18.2 selections are accepted;
- executable or health version drift fails before attach;
- hard-coded EXPECTED_VERSION 1.4.1 is removed;
- .cmd and unsafe executable rejection remains.

**Step 2: Run and verify RED**

~~~powershell
node --test test/runtime.test.js test/adapters/opencode-server.test.js test/runtime-start.test.js
~~~

Expected: FAIL because runtime/server still assume 1.4.1.

**Step 3: Implement exact-selection binding**

Use the shared resolver in production runtime construction and pass expectedVersion into OpenCodeServer. Preserve config digest, agent, tool, MCP, ownership, timeout, cleanup, and redaction checks.

**Step 4: Run and verify GREEN**

Run the command from Step 2. Expected: PASS.

**Step 5: Commit**

~~~powershell
git add src/runtime.js src/adapters/opencode-server.js src/index.js test/runtime.test.js test/adapters/opencode-server.test.js test/runtime-start.test.js
git commit -m "feat: bind selected OpenCode version"
~~~

### Task 6: Prove real 1.17.19 and 1.18.2 contracts

**Files:**
- Modify: test/adapters/opencode-config.test.js
- Modify: test/adapters/opencode-client.test.js
- Modify: test/adapters/opencode-server.test.js
- Modify only if observed: src/adapters/opencode-events.js
- Modify only if observed: src/adapters/opencode-client.js
- Modify only if observed: .opencode/agents/manual-video-planner.md
- Modify only if observed: .opencode/agents/manual-video-executor.md
- Modify after any trusted project change: src/adapters/opencode-server.js trusted digest

**Step 1: Write failing real-version tests**

Install OpenCode 1.17.19 in an ignored test runtime and use npm-native 1.18.2. Parameterize actual CLI integration tests over both. Require for each:

- debug config --pure resolves only approved MCP and fail-closed permission;
- both agents resolve without model drift or unsafe native tools;
- serve --pure exposes bounded health/config/agent/tool contracts;
- run JSON events preserve session IDs, tools, terminal text, and completion;
- session continuation stays on the requested session;
- unknown event envelopes still fail closed.

**Step 2: Run and verify RED**

~~~powershell
node --test test/adapters/opencode-config.test.js test/adapters/opencode-client.test.js test/adapters/opencode-server.test.js
~~~

Expected: current 1.4.1 assertions fail. Classify every additional failure as a concrete CLI/config/event difference before changing production code.

**Step 3: Implement only observed compatibility changes**

Normalize only shapes emitted by both supported versions. Do not add catch-all event handling. If agent/config sources change, recompute the trusted digest through the existing digest test rather than bypassing it.

**Step 4: Run and verify GREEN**

Run the command from Step 2 for both real versions. Expected: PASS.

**Step 5: Commit**

~~~powershell
git add test/adapters/opencode-config.test.js test/adapters/opencode-client.test.js test/adapters/opencode-server.test.js
git add src/adapters/opencode-events.js src/adapters/opencode-client.js src/adapters/opencode-server.js
git add .opencode/agents/manual-video-planner.md .opencode/agents/manual-video-executor.md
git commit -m "test: verify supported OpenCode contracts"
~~~

Stage only files that actually changed.

### Task 7: Document and verify the complete system

**Files:**
- Modify: README.md:23-34
- Modify design document only if evidence changes an approved detail
- Test: all test files and the existing final video artifact

**Step 1: Write the failing documentation assertion**

Require README to document OpenCode >=1.17.19, reuse of a compatible native executable, project-owned 1.18.2 fallback, no command-shim execution, and company-PC diagnostics.

**Step 2: Run and verify RED**

~~~powershell
node --test test/operational/scripts.test.js
~~~

Expected: FAIL because README still says exact 1.4.1.

**Step 3: Update README**

Remove downgrade-to-1.4.1 guidance and explain minimum versus fallback versions.

**Step 4: Run focused verification**

~~~powershell
node --test test/runtime/opencode-installation.test.js test/operational/opencode-runtime-script.test.js test/operational/scripts.test.js test/preflight.test.js test/runtime.test.js test/runtime-start.test.js test/adapters/opencode-client.test.js test/adapters/opencode-config.test.js test/adapters/opencode-server.test.js
~~~

Expected: PASS with zero failures.

**Step 5: Run full verification**

~~~powershell
npm run verify -- --artifact data/jobs/770eaf93-acd1-4b38-b446-11b3b3ca71d3/artifacts/final.mp4 --plan data/jobs/770eaf93-acd1-4b38-b446-11b3b3ca71d3/artifacts/media-plan.json
~~~

Expected: all tests, doctor, and MP4 quality checks pass. Doctor reports an actual selected OpenCode version at or above 1.17.19.

**Step 6: Run startup and real workflow smoke**

Start with PATH exposing 1.4.1 first and npm-native 1.18.2 later. Verify selection of 1.18.2, then run planning, approval, execution, composition, and final render. Separately run check mode against isolated 1.17.19 and prove no fallback install occurs.

**Step 7: Inspect final state**

~~~powershell
git diff --check
git status --short
git log --oneline -8
~~~

Expected: no generated runtime, credential, browser profile, or job artifact is staged.

**Step 8: Commit documentation**

~~~powershell
git add README.md test/operational/scripts.test.js
git commit -m "docs: document OpenCode compatibility"
~~~
