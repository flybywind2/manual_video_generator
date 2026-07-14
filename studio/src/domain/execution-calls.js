import { StudioError } from "./errors.js";
import { canonicalPlan } from "./plan.js";

function blockedPlan() {
  throw new StudioError("The plan contains a blocked step.", {
    code: "BLOCKED_PLAN",
    stage: "approved",
    retryable: false,
    details: { reason: "blocked_step_present" },
  });
}

function freezeCall(id, tool, argumentsValue) {
  return Object.freeze({
    id,
    tool,
    arguments: Object.freeze(argumentsValue),
  });
}

export function compileExecutionCalls(input) {
  const plan = canonicalPlan(input);
  if (plan.steps.some((step) => step.risk === "blocked")) {
    blockedPlan();
  }

  const calls = [
    freezeCall("system.start-video", "browser_start_video", {
      size: Object.freeze({
        width: plan.captureSettings.width,
        height: plan.captureSettings.height,
      }),
    }),
    freezeCall("system.show-actions", "browser_video_show_actions", {
      cursor: "pointer",
      duration: 700,
      position: "top-right",
    }),
  ];

  for (const step of plan.steps) {
    calls.push(
      freezeCall(`${step.id}.chapter`, "browser_video_chapter", {
        description: step.expected,
        duration: 800,
        title: step.action,
      }),
      ...step.calls,
      freezeCall(`${step.id}.evidence-snapshot`, "browser_snapshot", {}),
      freezeCall(`${step.id}.evidence-screenshot`, "browser_take_screenshot", {
        fullPage: false,
        scale: "css",
        type: "png",
      }),
    );
  }

  calls.push(
    freezeCall("system.hide-actions", "browser_video_hide_actions", {}),
    freezeCall("system.stop-video", "browser_stop_video", {}),
  );
  return Object.freeze(calls);
}
