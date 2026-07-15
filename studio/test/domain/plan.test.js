import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import {
  assertApprovedPlan,
  canonicalPlan,
  digestPlan,
  parseStableAccessibilityLocator,
  validatePlan,
} from "../../src/domain/plan.js";
import { evaluateStepPolicy } from "../../src/domain/policy.js";

const require = createRequire(import.meta.url);
const { iso: playwrightIsomorphic } = require("playwright-core/lib/coreBundle");

function validStep(overrides = {}) {
  const id = overrides.id ?? "step-01";
  return {
    id,
    action: "설정 메뉴 열기",
    expected: "설정 화면이 표시됨",
    narration: "상단 탐색 영역에서 설정 메뉴를 선택합니다.",
    risk: "safe",
    calls: overrides.calls ?? [
      {
        id: `${id}.click`,
        tool: "browser_click",
        arguments: { element: "설정 메뉴", target: "e11" },
      },
    ],
    ...overrides,
  };
}

function validPlan(overrides = {}) {
  return {
    schemaVersion: "1.1",
    targetUrl: "https://example.test/dashboard",
    targetOrigin: "https://example.test",
    authOrigins: ["https://login.example.test"],
    resourceOrigins: ["https://cdn.example.test"],
    successCriteria: ["설정 화면이 표시됨"],
    forbiddenActions: ["사용자 데이터 변경"],
    captureSettings: {
      width: 1920,
      height: 1080,
      fps: 30,
    },
    steps: [validStep()],
    ...overrides,
  };
}

test("plan rejects unknown top-level, capture, and step fields", () => {
  assert.throws(
    () => validatePlan({ ...validPlan(), extra: true }),
    { code: "INVALID_PLAN" },
  );
  assert.throws(
    () =>
      validatePlan({
        ...validPlan(),
        captureSettings: {
          ...validPlan().captureSettings,
          codec: "h264",
        },
      }),
    { code: "INVALID_PLAN" },
  );
  assert.throws(
    () => validatePlan(validPlan({ steps: [validStep({ selector: "#save" })] })),
    { code: "INVALID_PLAN" },
  );
});

test("plan requires an HTTP(S) target URL and matching canonical origin", () => {
  for (const targetUrl of [
    "file:///C:/private.html",
    "javascript:alert(1)",
    "ftp://example.test/file",
    "not a URL",
  ]) {
    assert.throws(() => validatePlan(validPlan({ targetUrl })), {
      code: "INVALID_PLAN",
    });
  }

  assert.throws(
    () =>
      validatePlan(
        validPlan({ targetUrl: "https://user:secret@example.test/dashboard" }),
      ),
    { code: "INVALID_PLAN" },
  );
  assert.throws(
    () => validatePlan(validPlan({ targetOrigin: "https://other.test" })),
    { code: "INVALID_PLAN" },
  );
});

test("plan accepts only the capture format produced by the fixed media pipeline", () => {
  assert.deepEqual(validatePlan(validPlan()).captureSettings, {
    width: 1920,
    height: 1080,
    fps: 30,
  });

  for (const captureSettings of [
    { width: 1280, height: 1080, fps: 30 },
    { width: 1920, height: 720, fps: 30 },
    { width: 1920, height: 1080, fps: 60 },
  ]) {
    assert.throws(
      () => validatePlan(validPlan({ captureSettings })),
      { code: "INVALID_PLAN" },
    );
  }
});

test("plan requires at least one step and caps plans at 12 executable steps", () => {
  assert.throws(() => validatePlan(validPlan({ steps: [] })), {
    code: "INVALID_PLAN",
  });

  const twelveSteps = Array.from({ length: 12 }, (_, index) =>
    validStep({ id: `step-${String(index + 1).padStart(2, "0")}` }),
  );
  assert.equal(validatePlan(validPlan({ steps: twelveSteps })).steps.length, 12);

  const thirteenSteps = [
    ...twelveSteps,
    validStep({ id: "step-13" }),
  ];
  assert.throws(() => validatePlan(validPlan({ steps: thirteenSteps })), {
    code: "INVALID_PLAN",
  });
});

test("plan rejects sparse step and string arrays", () => {
  assert.throws(() => validatePlan(validPlan({ steps: new Array(1) })), {
    code: "INVALID_PLAN",
  });
  assert.throws(
    () => validatePlan(validPlan({ successCriteria: new Array(1) })),
    { code: "INVALID_PLAN" },
  );
  assert.throws(
    () => validatePlan(validPlan({ forbiddenActions: new Array(1) })),
    { code: "INVALID_PLAN" },
  );
});

test("only safe, review, and blocked step risk values are accepted", () => {
  for (const risk of ["safe", "review", "blocked"]) {
    assert.equal(validatePlan(validPlan({ steps: [validStep({ risk })] })).steps[0].risk, risk);
  }

  for (const risk of ["unknown", "dangerous", "SAFE", "", null]) {
    assert.throws(
      () => validatePlan(validPlan({ steps: [validStep({ risk })] })),
      { code: "INVALID_PLAN" },
    );
  }
});

test("canonical plan is normalized and digest ignores object insertion order", () => {
  const first = validPlan({
    targetUrl: "https://EXAMPLE.test:443/dashboard",
    targetOrigin: "https://EXAMPLE.test:443/",
    successCriteria: ["  설정 화면이 표시됨  "],
    steps: [validStep({ action: "  설정 메뉴 열기  " })],
  });
  const reordered = {
    steps: [
      {
        risk: "safe",
        narration: "상단 탐색 영역에서 설정 메뉴를 선택합니다.",
        expected: "설정 화면이 표시됨",
        action: "설정 메뉴 열기",
        id: "step-01",
        calls: [
          {
            arguments: { target: "e11", element: "설정 메뉴" },
            tool: "browser_click",
            id: "step-01.click",
          },
        ],
      },
    ],
    captureSettings: { fps: 30, height: 1080, width: 1920 },
    forbiddenActions: ["사용자 데이터 변경"],
    successCriteria: ["설정 화면이 표시됨"],
    resourceOrigins: ["https://cdn.example.test"],
    authOrigins: ["https://login.example.test"],
    targetOrigin: "https://example.test",
    targetUrl: "https://example.test/dashboard",
    schemaVersion: "1.1",
  };

  assert.deepEqual(canonicalPlan(first), canonicalPlan(reordered));
  assert.equal(digestPlan(first), digestPlan(reordered));
  assert.match(digestPlan(first), /^[a-f0-9]{64}$/u);
});

test("plan canonicalizes bounded approved origin lists and binds them into the digest", () => {
  const canonical = canonicalPlan(validPlan({
    authOrigins: ["https://LOGIN.example.test:443/", "http://login-b.example.test:80"],
    resourceOrigins: ["https://static-b.example.test", "https://STATIC-a.example.test:443/"],
  }));

  assert.deepEqual(canonical.authOrigins, [
    "http://login-b.example.test",
    "https://login.example.test",
  ]);
  assert.deepEqual(canonical.resourceOrigins, [
    "https://static-a.example.test",
    "https://static-b.example.test",
  ]);
  assert.equal(Object.isFrozen(canonical.authOrigins), true);
  assert.equal(Object.isFrozen(canonical.resourceOrigins), true);
  assert.notEqual(
    digestPlan(canonical),
    digestPlan(validPlan({
      authOrigins: ["https://login.example.test"],
      resourceOrigins: ["https://static-a.example.test", "https://static-b.example.test"],
    })),
  );
});

test("plan rejects unsafe, duplicate, target, overlapping, and excessive approved origins", () => {
  for (const override of [
    { authOrigins: ["ftp://login.example.test"] },
    { authOrigins: ["https://user:secret@login.example.test"] },
    { authOrigins: ["https://login.example.test/path"] },
    { resourceOrigins: ["https://cdn.example.test?token=secret"] },
    { resourceOrigins: ["https://cdn.example.test#fragment"] },
    { authOrigins: ["https://example.test"] },
    { authOrigins: ["https://LOGIN.example.test:443", "https://login.example.test/"] },
    {
      authOrigins: ["https://shared.example.test"],
      resourceOrigins: ["https://SHARED.example.test:443/"],
    },
    {
      authOrigins: Array.from({ length: 17 }, (_, index) => `https://login-${index}.example.test`),
    },
  ]) {
    assert.throws(() => validatePlan(validPlan(override)), {
      code: "INVALID_PLAN",
    });
  }
});

test("plan binds every step to exact bounded browser calls", () => {
  const plan = canonicalPlan(validPlan());
  assert.deepEqual(plan.steps[0].calls, [
    {
      id: "step-01.click",
      tool: "browser_click",
      arguments: { element: "설정 메뉴", target: "e11" },
    },
  ]);

  for (const calls of [
    [],
    [{ id: "bad", tool: "browser_navigate", arguments: { url: "https://example.test" } }],
    [{ id: "bad", tool: "browser_click", arguments: { target: "e11", filename: "escape.png" } }],
    [{ id: "bad", tool: "browser_type", arguments: { target: "password", text: "secret" } }],
    [{ id: "bad", tool: "browser_press_key", arguments: { key: "Enter" } }],
  ]) {
    assert.throws(
      () => canonicalPlan(validPlan({ steps: [validStep({ calls })] })),
      { code: "INVALID_PLAN" },
    );
  }
});

test("stable accessibility locators are exact, reviewable, and policy-inspected by accessible name", () => {
  const target = 'getByRole("link", { name: "프로젝트 메뉴 열기", exact: true })';
  assert.deepEqual(parseStableAccessibilityLocator(target), {
    role: "link",
    name: "프로젝트 메뉴 열기",
    exact: true,
  });
  assert.deepEqual(
    parseStableAccessibilityLocator('getByRole("link", { name: "Manual Video 프로젝트" })'),
    { role: "link", name: "Manual Video 프로젝트", exact: false },
  );
  assert.deepEqual(
    parseStableAccessibilityLocator('getByText("주요재무", { exact: true })'),
    { method: "getByText", name: "주요재무", exact: true },
  );
  assert.deepEqual(
    parseStableAccessibilityLocator('getByText("주요재무")'),
    { method: "getByText", name: "주요재무", exact: false },
  );
  assert.equal(
    parseStableAccessibilityLocator('getByText("주요재무", { exact: false })'),
    null,
  );
  for (const unstableTarget of [
    'getByText(/주요재무/)',
    'getByText("주요재무").nth(0)',
    'getByText("주요재무").filter({ visible: true })',
    'locator("text=주요재무")',
    'text=주요재무',
    'getByText(\'주요재무\')',
    'getByText(" 주요재무")',
    'getByText("주요재무", { exact: true, timeout: 1 })',
  ]) {
    assert.equal(parseStableAccessibilityLocator(unstableTarget), null);
  }
  assert.equal(parseStableAccessibilityLocator(`getByText("${"가".repeat(513)}")`), null);
  assert.equal(
    parseStableAccessibilityLocator('getByRole("link", { name: "Manual Video 프로젝트", exact: false })'),
    null,
  );
  assert.equal(parseStableAccessibilityLocator("e11"), null);
  assert.equal(
    parseStableAccessibilityLocator("getByRole('link', { name: '프로젝트', exact: true })"),
    null,
  );
  assert.equal(
    canonicalPlan(validPlan({
      steps: [validStep({
        calls: [{
          id: "step-01.click",
          tool: "browser_click",
          arguments: { element: "프로젝트 메뉴 열기", target },
        }],
      })],
    })).steps[0].risk,
    "safe",
  );

  const forbiddenTarget = 'getByRole("button", { name: "프로젝트 삭제", exact: true })';
  assert.equal(
    canonicalPlan(validPlan({
      forbiddenActions: ["record.delete"],
      steps: [validStep({
        calls: [{
          id: "step-01.click",
          tool: "browser_click",
          arguments: { element: "프로젝트 삭제", target: forbiddenTarget },
        }],
      })],
    })).steps[0].risk,
    "blocked",
  );
});

test("stable accessibility locator grammar is accepted by the pinned Playwright MCP parser", () => {
  const exact = 'getByRole("link", { name: "프로젝트 메뉴 열기", exact: true })';
  const partial = 'getByRole("link", { name: "Manual Video 프로젝트" })';
  const exactText = 'getByText("주요재무", { exact: true })';
  const partialText = 'getByText("주요재무")';
  for (const target of [exact, partial, exactText, partialText]) {
    assert.notEqual(
      playwrightIsomorphic.locatorOrSelectorAsSelector("javascript", target, "data-testid"),
      "",
    );
  }
  assert.equal(
    playwrightIsomorphic.locatorOrSelectorAsSelector(
      "javascript",
      'getByRole("link", { name: "Manual Video 프로젝트", exact: false })',
      "data-testid",
    ),
    "",
  );
});

test("call ids are globally unique and exact call arguments are approval-digested", () => {
  const second = validStep({
    id: "step-02",
    action: "도움말 메뉴 열기",
    calls: [{ id: "step-02.click", tool: "browser_click", arguments: { target: "e12" } }],
  });
  const plan = validPlan({ steps: [validStep(), second] });
  const changed = validPlan({
    steps: [
      validStep({
        calls: [{ id: "step-01.click", tool: "browser_click", arguments: { element: "설정 메뉴", target: "e99" } }],
      }),
      second,
    ],
  });
  assert.notEqual(digestPlan(plan), digestPlan(changed));

  assert.throws(
    () => canonicalPlan(validPlan({
      steps: [validStep(), { ...second, calls: [{ id: "step-01.click", tool: "browser_click", arguments: { target: "e12" } }] }],
    })),
    { code: "INVALID_PLAN" },
  );
  assert.throws(
    () => canonicalPlan(validPlan({
      steps: [validStep({
        calls: [{ id: "step-01.result-dwell", tool: "browser_wait_for", arguments: { time: 2 } }],
      })],
    })),
    { code: "INVALID_PLAN" },
  );
});

test("canonical plans are bounded to fit the Windows OpenCode execution command", () => {
  const oversized = validPlan({
    steps: [
      validStep({ narration: "가".repeat(4_000) }),
      validStep({
        id: "step-02",
        narration: "나".repeat(4_000),
        calls: [
          {
            id: "step-02.click",
            tool: "browser_click",
            arguments: { element: "도움말 메뉴", target: "e12" },
          },
        ],
      }),
    ],
  });

  assert.throws(() => canonicalPlan(oversized), { code: "INVALID_PLAN" });
});

test("step narration is concise enough for the bounded capture dwell", () => {
  assert.equal(
    canonicalPlan(validPlan({
      steps: [validStep({ narration: "가".repeat(60) })],
    })).steps[0].narration.length,
    60,
  );
  assert.throws(
    () => canonicalPlan(validPlan({
      steps: [validStep({ narration: "가".repeat(61) })],
    })),
    { code: "INVALID_PLAN" },
  );
});

test("approved digest is required to match the exact canonical plan", () => {
  const plan = validPlan();
  const digest = digestPlan(plan);

  assert.deepEqual(assertApprovedPlan(plan, digest), canonicalPlan(plan));
  assert.throws(
    () =>
      assertApprovedPlan(
        validPlan({
          steps: [validStep({ narration: "변경된 내레이션입니다." })],
        }),
        digest,
      ),
    { code: "PLAN_DIGEST_MISMATCH" },
  );
  assert.throws(() => assertApprovedPlan(plan, "not-a-digest"), {
    code: "PLAN_DIGEST_MISMATCH",
  });
});

test("digest-matching blocked plans remain reviewable but cannot pass execution approval", () => {
  const blockedPlan = validPlan({
    steps: [validStep({ action: "Submit the form", risk: "safe" })],
  });
  const canonical = canonicalPlan(blockedPlan);

  assert.equal(canonical.steps[0].risk, "blocked");
  assert.match(digestPlan(blockedPlan), /^[a-f0-9]{64}$/u);
  assert.throws(
    () => assertApprovedPlan(blockedPlan, digestPlan(blockedPlan)),
    {
      code: "BLOCKED_PLAN",
      stage: "approved",
      retryable: false,
    },
  );
});

test("forbidden action conflicts are normalized and block execution approval", () => {
  const plan = validPlan({
    forbiddenActions: ["change user data"],
    steps: [
      validStep({
        action: "Open settings, then ＣＨＡＮＧＥ   USER\tDATA now",
      }),
    ],
  });
  const canonical = canonicalPlan(plan);

  assert.equal(canonical.steps[0].risk, "blocked");
  assert.throws(() => assertApprovedPlan(plan, digestPlan(plan)), {
    code: "BLOCKED_PLAN",
  });
});

test("forbidden action normalization is deterministic and respects token boundaries", () => {
  const first = validPlan({
    forbiddenActions: ["  Change   User Data  "],
  });
  const equivalent = validPlan({
    forbiddenActions: ["ＣＨＡＮＧＥ　ＵＳＥＲ　ＤＡＴＡ"],
  });

  assert.deepEqual(
    canonicalPlan(first).forbiddenActions,
    ["user-data.change"],
  );
  assert.equal(digestPlan(first), digestPlan(equivalent));
  assert.equal(
    digestPlan(first),
    digestPlan(validPlan({ forbiddenActions: ["user-data.change"] })),
  );

  const boundarySafe = canonicalPlan(
    validPlan({
      forbiddenActions: ["change user data"],
      steps: [validStep({ action: "Review exchange user database" })],
    }),
  );
  assert.equal(boundarySafe.steps[0].risk, "safe");
});

test("enumerated forbidden capabilities cover English inflection and Korean morphology", () => {
  for (const [forbiddenAction, action] of [
    ["change user data", "Changing user data"],
    ["change user data", "Change the user data"],
    ["change user data", "Change the user's data"],
    ["change user data", "Update user data"],
    ["사용자 데이터 변경", "사용자 데이터를 변경합니다"],
    ["사용자 데이터 변경", "사용자의 데이터를 변경합니다"],
    ["사용자 데이터 변경", "사용자 데이터를 변경해 주세요"],
    ["user-data.change", "Change user data"],
  ]) {
    const plan = validPlan({
      forbiddenActions: [forbiddenAction],
      steps: [validStep({ action })],
    });
    assert.deepEqual(canonicalPlan(plan).forbiddenActions, [
      "user-data.change",
    ]);
    assert.equal(canonicalPlan(plan).steps[0].risk, "blocked");
    assert.throws(() => assertApprovedPlan(plan, digestPlan(plan)), {
      code: "BLOCKED_PLAN",
    });
  }

  assert.throws(
    () => canonicalPlan(validPlan({ forbiddenActions: ["arbitrary free text"] })),
    { code: "INVALID_PLAN" },
  );
});

test("policy allows navigation within the approved target origin", () => {
  assert.equal(
    evaluateStepPolicy(
      validStep({ action: "Open https://example.test/settings" }),
      "https://example.test",
    ),
    "safe",
  );
});

test("policy blocks navigation to any other origin", () => {
  assert.equal(
    evaluateStepPolicy(
      validStep({ action: "Navigate to https://other.test/settings" }),
      "https://example.test",
    ),
    "blocked",
  );
  assert.equal(
    validatePlan(
      validPlan({
        steps: [validStep({ action: "Open https://other.test/settings" })],
      }),
    ).steps[0].risk,
    "blocked",
  );
});

test("policy blocks host-only cross-origin navigation and allows the approved host", () => {
  for (const action of [
    "Navigate to other.test/settings",
    "Load other.test/settings",
    "Click the link to other.test/settings",
    "other.test 링크 클릭",
  ]) {
    assert.equal(
      evaluateStepPolicy(validStep({ action }), "https://example.test"),
      "blocked",
    );
  }
  assert.equal(
    evaluateStepPolicy(
      validStep({
        action: "Navigate to example.test/settings",
        navigationTarget: "https://example.test/settings",
      }),
      "https://example.test",
    ),
    "safe",
  );
});

test("structured navigation target is optional, canonical, and origin constrained", () => {
  const fiveFieldStep = canonicalPlan(validPlan()).steps[0];
  assert.equal(Object.hasOwn(fiveFieldStep, "navigationTarget"), false);

  const sameOrigin = canonicalPlan(
    validPlan({
      steps: [
        validStep({
          action: "Navigate to settings",
          navigationTarget: "https://EXAMPLE.test:443/settings",
        }),
      ],
    }),
  );
  assert.equal(
    sameOrigin.steps[0].navigationTarget,
    "https://example.test/settings",
  );
  assert.equal(sameOrigin.steps[0].risk, "safe");

  const explicitNull = canonicalPlan(
    validPlan({ steps: [validStep({ navigationTarget: null })] }),
  );
  assert.equal(explicitNull.steps[0].navigationTarget, null);

  const crossOrigin = validPlan({
    steps: [
      validStep({
        action: "Navigate to settings",
        navigationTarget: "https://other.test/settings",
      }),
    ],
  });
  assert.equal(canonicalPlan(crossOrigin).steps[0].risk, "blocked");
  assert.throws(
    () => assertApprovedPlan(crossOrigin, digestPlan(crossOrigin)),
    { code: "BLOCKED_PLAN" },
  );

  assert.throws(
    () =>
      canonicalPlan(
        validPlan({
          steps: [
            validStep({
              navigationTarget:
                "https://user:secret@example.test/settings",
            }),
          ],
        }),
      ),
    { code: "INVALID_PLAN" },
  );
});

test("ambiguous host, route, and file navigation requires structured metadata", () => {
  for (const action of [
    "Navigate to intranet-admin/settings",
    "Open manual.pdf preview",
    "Navigate to example.test/settings",
  ]) {
    assert.equal(
      evaluateStepPolicy(validStep({ action }), "https://example.test"),
      "blocked",
    );
  }

  assert.equal(
    evaluateStepPolicy(
      validStep({
        action: "Navigate to intranet-admin/settings",
        navigationTarget: "https://example.test/intranet-admin/settings",
      }),
      "https://example.test",
    ),
    "safe",
  );
  assert.equal(
    evaluateStepPolicy(
      validStep({
        action: "Open manual.pdf preview",
        navigationTarget: "https://example.test/manual.pdf",
      }),
      "https://example.test",
    ),
    "safe",
  );
});

test("navigation text cannot contradict structured metadata", () => {
  for (const action of [
    "Open https://other.test/settings",
    "Open //other.test/settings",
    "Navigate to other.test/settings",
  ]) {
    assert.equal(
      evaluateStepPolicy(
        validStep({
          action,
          navigationTarget: "https://example.test/settings",
        }),
        "https://example.test",
      ),
      "blocked",
    );
  }

  assert.equal(
    evaluateStepPolicy(
      validStep({
        action: "Open https://example.test/settings",
        navigationTarget: "https://example.test/dashboard",
      }),
      "https://example.test",
    ),
    "blocked",
  );
});

test("navigation text is NFKC-normalized and rejects unsafe schemes", () => {
  for (const action of [
    "Navigate to javascript:alert(1)",
    "Navigate to file:///C:/Windows/System32",
    "Navigate to data:text/html,unsafe",
    "Navigate to other．test/settings",
    "Navigate to other。test/settings",
    "Navigate to other｡test/settings",
    "Navigate to 例え.テスト/settings",
  ]) {
    const plan = validPlan({ steps: [validStep({ action })] });
    assert.equal(canonicalPlan(plan).steps[0].risk, "blocked");
    assert.throws(() => assertApprovedPlan(plan, digestPlan(plan)), {
      code: "BLOCKED_PLAN",
    });
  }
});

test("relative navigation must exactly match structured metadata", () => {
  for (const [action, navigationTarget] of [
    ["Navigate to /admin", undefined],
    ["Navigate to /admin", "https://example.test/settings"],
    ["Navigate to ?tab=admin", undefined],
    ["Navigate to #admin", undefined],
    ["Navigate to ../admin", undefined],
    ["Navigate to ./admin", undefined],
    ["Navigate to ../admin", "https://example.test/settings"],
    ["Navigate to [/admin]", undefined],
  ]) {
    const step =
      navigationTarget === undefined
        ? validStep({ action })
        : validStep({ action, navigationTarget });
    assert.equal(
      evaluateStepPolicy(step, "https://example.test"),
      "blocked",
    );
  }

  for (const [action, navigationTarget] of [
    ["Navigate to /admin", "https://example.test/admin"],
    ["Navigate to ?tab=admin", "https://example.test/?tab=admin"],
    ["Navigate to #admin", "https://example.test/#admin"],
    ["Navigate to ../admin", "https://example.test/admin"],
    ["Navigate to ./admin", "https://example.test/admin"],
    ["Navigate to [/admin]", "https://example.test/admin"],
  ]) {
    assert.equal(
      evaluateStepPolicy(
        validStep({ action, navigationTarget }),
        "https://example.test",
      ),
      "safe",
    );
  }
});

test("policy accepts only own fields on plain or null-prototype steps", () => {
  const inherited = Object.create({
    action: "Open https://example.test/settings",
    risk: "safe",
  });
  assert.equal(
    evaluateStepPolicy(inherited, "https://example.test"),
    "blocked",
  );

  class Step {
    constructor() {
      this.action = "Open https://example.test/settings";
      this.risk = "safe";
    }
  }
  assert.equal(
    evaluateStepPolicy(new Step(), "https://example.test"),
    "blocked",
  );
  assert.equal(
    evaluateStepPolicy({ action: "Open settings" }, "https://example.test"),
    "blocked",
  );

  const nullPrototype = Object.assign(Object.create(null), {
    action: "Open https://example.test/settings",
    risk: "safe",
  });
  assert.equal(
    evaluateStepPolicy(nullPrototype, "https://example.test"),
    "safe",
  );
});

test("policy requires targetOrigin to be an exact canonical HTTP(S) origin", () => {
  for (const targetOrigin of [
    "https://example.test/not-an-origin",
    "https://user:secret@example.test",
    "https://example.test?next=/settings",
    "https://example.test#settings",
  ]) {
    assert.equal(
      evaluateStepPolicy(
        validStep({ action: "Open https://example.test/settings" }),
        targetOrigin,
      ),
      "blocked",
    );
  }
});

test("policy fails closed when a step has an invalid risk", () => {
  assert.equal(
    evaluateStepPolicy(
      validStep({ risk: "garbage" }),
      "https://example.test",
    ),
    "blocked",
  );
});

test("policy blocks irreversible English verbs as tokens", () => {
  for (const verb of [
    "delete",
    "remove",
    "send",
    "submit",
    "publish",
    "purchase",
  ]) {
    assert.equal(
      evaluateStepPolicy(validStep({ action: `${verb} the request` }), "https://example.test"),
      "blocked",
    );
  }

  assert.equal(
    evaluateStepPolicy(
      validStep({ action: "Open sender settings and purchaseHistory report" }),
      "https://example.test",
    ),
    "safe",
  );
});

test("policy blocks irreversible Korean action tokens", () => {
  for (const action of [
    "항목을 삭제합니다",
    "보고서 전송 버튼 누르기",
    "새 사용자를 등록하기",
    "상품 구매 버튼 클릭",
    "사용자를 등록시킵니다",
  ]) {
    assert.equal(
      evaluateStepPolicy(validStep({ action }), "https://example.test"),
      "blocked",
    );
  }

  assert.equal(
    evaluateStepPolicy(
      validStep({ action: "등록된 사용자 목록 보기" }),
      "https://example.test",
    ),
    "safe",
  );
});

test("validation forces dangerous steps to blocked without trusting declared risk", () => {
  const plan = validatePlan(
    validPlan({
      steps: [validStep({ action: "Submit the form", risk: "review" })],
    }),
  );

  assert.equal(plan.steps[0].risk, "blocked");
});
