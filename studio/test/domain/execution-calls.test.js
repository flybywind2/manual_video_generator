import assert from "node:assert/strict";
import test from "node:test";

import { compileExecutionCalls } from "../../src/domain/execution-calls.js";

function plan() {
  return {
    schemaVersion: "1.1",
    targetUrl: "https://example.test/dashboard",
    targetOrigin: "https://example.test",
    authOrigins: [],
    resourceOrigins: [],
    successCriteria: ["Manual Video 화면이 표시됨"],
    forbiddenActions: ["사용자 데이터 변경"],
    captureSettings: { width: 1920, height: 1080, fps: 30 },
    steps: [
      {
        id: "step-01",
        action: "프로젝트 메뉴 열기",
        expected: "프로젝트 목록이 표시됨",
        narration: "프로젝트 메뉴를 선택합니다.",
        risk: "safe",
        calls: [
          { id: "step-01.click", tool: "browser_click", arguments: { element: "프로젝트 메뉴", target: 'getByRole("link", { name: "프로젝트 메뉴", exact: true })' } },
          { id: "step-01.wait", tool: "browser_wait_for", arguments: { text: "프로젝트" } },
        ],
      },
    ],
  };
}

test("execution calls deterministically wrap exact approved actions with recording and evidence", () => {
  const calls = compileExecutionCalls(plan());
  assert.deepEqual(calls, [
    { id: "system.start-video", tool: "browser_start_video", arguments: { size: { width: 1920, height: 1080 } } },
    { id: "system.show-actions", tool: "browser_video_show_actions", arguments: { cursor: "pointer", duration: 700, position: "top-right" } },
    { id: "step-01.chapter", tool: "browser_video_chapter", arguments: { description: "프로젝트 목록이 표시됨", duration: 800, title: "프로젝트 메뉴 열기" } },
    { id: "step-01.narration-dwell", tool: "browser_wait_for", arguments: { time: 6 } },
    { id: "step-01.click", tool: "browser_click", arguments: { element: "프로젝트 메뉴", target: 'getByRole("link", { name: "프로젝트 메뉴", exact: true })' } },
    { id: "step-01.wait", tool: "browser_wait_for", arguments: { text: "프로젝트" } },
    { id: "step-01.result-dwell", tool: "browser_wait_for", arguments: { time: 2 } },
    { id: "step-01.evidence-snapshot", tool: "browser_snapshot", arguments: {} },
    { id: "step-01.evidence-screenshot", tool: "browser_take_screenshot", arguments: { fullPage: false, scale: "css", type: "png" } },
    { id: "system.hide-actions", tool: "browser_video_hide_actions", arguments: {} },
    { id: "system.stop-video", tool: "browser_stop_video", arguments: {} },
  ]);
  assert.equal(Object.isFrozen(calls), true);
  assert.equal(Object.isFrozen(calls[3].arguments), true);
});

test("wait-only steps retain a narration dwell when a text condition resolves immediately", () => {
  const candidate = plan();
  candidate.steps = [
    {
      ...candidate.steps[0],
      calls: [
        {
          id: "step-01.wait",
          tool: "browser_wait_for",
          arguments: { time: 5, text: "프로젝트" },
        },
      ],
    },
  ];

  assert.equal(
    compileExecutionCalls(candidate).some(({ id }) => id === "step-01.narration-dwell"),
    true,
  );
  assert.equal(
    compileExecutionCalls(candidate).some(({ id }) => id === "step-01.result-dwell"),
    false,
  );
});

test("execution call compilation canonicalizes and rejects blocked or unapproved plans", () => {
  assert.throws(
    () => compileExecutionCalls({ ...plan(), steps: [{ ...plan().steps[0], action: "Delete project" }] }),
    { code: "BLOCKED_PLAN" },
  );
  assert.throws(
    () => compileExecutionCalls({ ...plan(), schemaVersion: "1.0" }),
    { code: "INVALID_PLAN" },
  );
});
