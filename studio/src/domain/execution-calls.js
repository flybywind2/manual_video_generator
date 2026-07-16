import { StudioError } from "./errors.js";
import { canonicalPlan } from "./plan.js";

export const ACTION_NARRATION_DWELL_SECONDS = 6;
export const ACTION_RESULT_DWELL_SECONDS = 2;
export const CLICK_GEOMETRY_FUNCTION = '(element) => { element.scrollIntoView({ behavior: "instant", block: "nearest", inline: "nearest" }); const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height }; }';
const CLICK_GEOMETRY_RESPONSE_META = Object.freeze({ json: true });

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

function expandedCalls(calls) {
  return calls.flatMap((call) => call.tool === "browser_click"
    ? [
        freezeCall(`${call.id}.highlight-bounds`, "browser_evaluate", {
          ...(call.arguments.element === undefined ? {} : { element: call.arguments.element }),
          target: call.arguments.target,
          function: CLICK_GEOMETRY_FUNCTION,
          _meta: CLICK_GEOMETRY_RESPONSE_META,
        }),
        call,
      ]
    : [call]);
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
    const waitOnly = step.calls.every((call) => call.tool === "browser_wait_for");
    calls.push(
      freezeCall(`${step.id}.chapter`, "browser_video_chapter", {
        description: step.expected,
        duration: 800,
        title: step.action,
      }),
      freezeCall(`${step.id}.narration-dwell`, "browser_wait_for", {
        time: ACTION_NARRATION_DWELL_SECONDS,
      }),
      ...expandedCalls(step.calls),
      ...(waitOnly
        ? []
        : [freezeCall(`${step.id}.result-dwell`, "browser_wait_for", {
            time: ACTION_RESULT_DWELL_SECONDS,
          })]),
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
