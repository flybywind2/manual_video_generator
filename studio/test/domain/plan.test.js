import assert from "node:assert/strict";
import test from "node:test";

import {
  assertApprovedPlan,
  canonicalPlan,
  digestPlan,
  validatePlan,
} from "../../src/domain/plan.js";
import { evaluateStepPolicy } from "../../src/domain/policy.js";

function validStep(overrides = {}) {
  return {
    id: "step-01",
    action: "설정 메뉴 열기",
    expected: "설정 화면이 표시됨",
    narration: "상단 탐색 영역에서 설정 메뉴를 선택합니다.",
    risk: "safe",
    ...overrides,
  };
}

function validPlan(overrides = {}) {
  return {
    schemaVersion: "1.0",
    targetUrl: "https://example.test/dashboard",
    targetOrigin: "https://example.test",
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

test("plan requires at least one step and caps plans at 30 steps", () => {
  assert.throws(() => validatePlan(validPlan({ steps: [] })), {
    code: "INVALID_PLAN",
  });

  const thirtySteps = Array.from({ length: 30 }, (_, index) =>
    validStep({ id: `step-${String(index + 1).padStart(2, "0")}` }),
  );
  assert.equal(validatePlan(validPlan({ steps: thirtySteps })).steps.length, 30);

  const thirtyOneSteps = [
    ...thirtySteps,
    validStep({ id: "step-31" }),
  ];
  assert.throws(() => validatePlan(validPlan({ steps: thirtyOneSteps })), {
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
      },
    ],
    captureSettings: { fps: 30, height: 1080, width: 1920 },
    forbiddenActions: ["사용자 데이터 변경"],
    successCriteria: ["설정 화면이 표시됨"],
    targetOrigin: "https://example.test",
    targetUrl: "https://example.test/dashboard",
    schemaVersion: "1.0",
  };

  assert.deepEqual(canonicalPlan(first), canonicalPlan(reordered));
  assert.equal(digestPlan(first), digestPlan(reordered));
  assert.match(digestPlan(first), /^[a-f0-9]{64}$/u);
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
  assert.equal(
    evaluateStepPolicy(
      validStep({ action: "Navigate to other.test/settings" }),
      "https://example.test",
    ),
    "blocked",
  );
  assert.equal(
    evaluateStepPolicy(
      validStep({ action: "Navigate to example.test/settings" }),
      "https://example.test",
    ),
    "safe",
  );
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
