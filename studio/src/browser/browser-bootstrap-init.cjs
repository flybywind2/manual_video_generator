"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

const guardedContexts = new WeakMap();
const guardedPages = new Set();
const frameUrlsByPage = new WeakMap();
const pendingDocumentNavigationsByPage = new WeakMap();
const readyPages = new WeakSet();
const mainFrameNavigationCounts = new WeakMap();
const credentialKeys = [
  "MANUAL_STUDIO_LOGIN_USERNAME",
  "MANUAL_STUDIO_LOGIN_PASSWORD",
];
const authSealContents = "manual-video-auth-sealed-v1\n";
const authAckContents = "manual-video-auth-armed-v1\n";

function fail(message) {
  throw new Error(message);
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function canonicalOrigin(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    fail("Invalid browser origin policy.");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("Invalid browser origin policy.");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.origin !== value ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    fail("Invalid browser origin policy.");
  }
  return parsed.origin;
}

function parseOrigins(source) {
  let values;
  try {
    values = JSON.parse(source);
  } catch {
    fail("Invalid browser origin policy.");
  }
  if (!Array.isArray(values) || values.length === 0 || values.length > 32) {
    fail("Invalid browser origin policy.");
  }
  const origins = values.map(canonicalOrigin);
  if (new Set(origins).size !== origins.length) {
    fail("Invalid browser origin policy.");
  }
  return Object.freeze(origins);
}

function safeSelector(value, fallback) {
  const selected = value === undefined || value === "" ? fallback : value;
  if (
    typeof selected !== "string" ||
    selected.length > 160 ||
    /[\0\r\n,]/u.test(selected) ||
    !/^(?:#[A-Za-z][A-Za-z0-9_-]{0,80}|\[name="[A-Za-z][A-Za-z0-9_.:-]{0,80}"\]|input\[type="(?:email|password|text)"\]|button\[type="submit"\])$/u.test(selected)
  ) {
    fail("Invalid automatic login selector.");
  }
  return selected;
}

const allowedOrigins = new Set(parseOrigins(process.env.MANUAL_STUDIO_ALLOWED_ORIGINS));
const navigationOrigins = new Set(parseOrigins(process.env.MANUAL_STUDIO_NAVIGATION_ORIGINS));
if ([...navigationOrigins].some((origin) => !allowedOrigins.has(origin))) {
  fail("Invalid browser navigation policy.");
}
let initialTargetUrl;
let targetOrigin;
let targetCompletionUrl;
try {
  const parsedTarget = new URL(process.env.MANUAL_STUDIO_TARGET_URL);
  if (
    (parsedTarget.protocol !== "http:" && parsedTarget.protocol !== "https:") ||
    parsedTarget.username ||
    parsedTarget.password ||
    !navigationOrigins.has(parsedTarget.origin)
  ) {
    fail("Invalid browser target URL.");
  }
  initialTargetUrl = parsedTarget.href;
  targetOrigin = parsedTarget.origin;
  parsedTarget.hash = "";
  targetCompletionUrl = parsedTarget.href;
} catch {
  fail("Invalid browser target URL.");
}
const authenticationOrigins = new Set(
  [...navigationOrigins].filter((origin) => origin !== targetOrigin),
);
const authSealPath = process.env.MANUAL_STUDIO_AUTH_SEAL_PATH;
if (
  typeof authSealPath !== "string" ||
  authSealPath.length === 0 ||
  authSealPath.length > 4096 ||
  authSealPath.includes("\0") ||
  !path.isAbsolute(authSealPath) ||
  path.basename(authSealPath) !== "auth-sealed"
) {
  fail("Invalid browser authentication seal path.");
}
const authAckPath = process.env.MANUAL_STUDIO_AUTH_ACK_PATH;
if (
  typeof authAckPath !== "string" ||
  authAckPath.length === 0 ||
  authAckPath.length > 4096 ||
  authAckPath.includes("\0") ||
  !path.isAbsolute(authAckPath) ||
  path.basename(authAckPath) !== "auth-armed" ||
  pathKey(path.dirname(authAckPath)) !== pathKey(path.dirname(authSealPath))
) {
  fail("Invalid browser authentication acknowledgement path.");
}
const authMode = process.env.MANUAL_STUDIO_AUTH_MODE;
if (authMode !== "manual" && authMode !== "automatic") {
  fail("Invalid browser authentication mode.");
}

let loginUsername;
let loginPassword;
let loginOrigin;
let selectors;
let loginCompleted = false;
let credentialSubmitted = false;
let credentialPage = null;
let credentialSubmissionNavigation = -1;
let credentialPageWasExactTarget = false;
let loginInProgress = false;
let initialNavigationClaimed = false;
let fatalNavigationTriggered = false;
if (authMode === "automatic") {
  loginUsername = process.env.MANUAL_STUDIO_LOGIN_USERNAME;
  loginPassword = process.env.MANUAL_STUDIO_LOGIN_PASSWORD;
  loginOrigin = canonicalOrigin(process.env.MANUAL_STUDIO_LOGIN_ORIGIN);
  if (
    !navigationOrigins.has(loginOrigin) ||
    typeof loginUsername !== "string" ||
    loginUsername.length === 0 ||
    loginUsername.length > 256 ||
    typeof loginPassword !== "string" ||
    loginPassword.length === 0 ||
    loginPassword.length > 4096 ||
    /[\0\r\n]/u.test(loginUsername) ||
    /[\0\r\n]/u.test(loginPassword)
  ) {
    fail("Invalid automatic login configuration.");
  }
  selectors = Object.freeze({
    username: safeSelector(process.env.MANUAL_STUDIO_USERNAME_SELECTOR, '[name="username"]'),
    password: safeSelector(process.env.MANUAL_STUDIO_PASSWORD_SELECTOR, '[name="password"]'),
    submit: safeSelector(process.env.MANUAL_STUDIO_SUBMIT_SELECTOR, 'button[type="submit"]'),
  });
}

for (const key of Object.keys(process.env)) {
  if (key.startsWith("MANUAL_STUDIO_")) {
    delete process.env[key];
  }
}
for (const key of credentialKeys) {
  delete process.env[key];
}

function originAllowed(urlValue, websocket = false) {
  try {
    const parsed = new URL(urlValue);
    if (websocket) {
      if (parsed.protocol === "ws:") parsed.protocol = "http:";
      else if (parsed.protocol === "wss:") parsed.protocol = "https:";
      else return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (authenticationOrigins.has(parsed.origin) && authenticationSealed()) return false;
    return allowedOrigins.has(parsed.origin);
  } catch {
    return false;
  }
}

function markerFileIsValid(markerPath, contents) {
  const status = fs.lstatSync(markerPath);
  return (
    status.isFile() &&
    !status.isSymbolicLink() &&
    status.nlink === 1 &&
    status.size === Buffer.byteLength(contents) &&
    pathKey(fs.realpathSync(markerPath)) === pathKey(markerPath) &&
    fs.readFileSync(markerPath, "utf8") === contents
  );
}

function authenticationSealed() {
  if (loginCompleted) return true;
  try {
    markerFileIsValid(authSealPath, authSealContents);
    return true;
  } catch (error) {
    return error?.code !== "ENOENT";
  }
}

function publishAuthenticationMarker(markerPath, contents, invalidMessage) {
  try {
    if (markerFileIsValid(markerPath, contents)) return;
    fail(invalidMessage);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporaryPath = path.join(
    path.dirname(markerPath),
    `.${path.basename(markerPath)}.${process.pid}.${Date.now()}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor;
  let renamed = false;
  try {
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow,
      0o600,
    );
    fs.writeFileSync(descriptor, contents, { encoding: "utf8" });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.renameSync(temporaryPath, markerPath);
      renamed = true;
    } catch (error) {
      if (
        !["EEXIST", "EPERM"].includes(error?.code) ||
        !markerFileIsValid(markerPath, contents)
      ) {
        throw error;
      }
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (!renamed) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  if (!markerFileIsValid(markerPath, contents)) fail(invalidMessage);
}

function writeAuthenticationSeal() {
  publishAuthenticationMarker(
    authSealPath,
    authSealContents,
    "Invalid browser authentication seal.",
  );
  loginCompleted = true;
}

function closePageFailClosed(page) {
  void Promise.resolve()
    .then(() => page.close({ runBeforeUnload: false }))
    .catch(() => undefined);
}

function authenticationMarkerState(markerPath, contents) {
  try {
    return markerFileIsValid(markerPath, contents) ? "valid" : "invalid";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    return "invalid";
  }
}

function frameHasUnsafeOrigin(urlValue) {
  try {
    const parsed = new URL(urlValue);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return parsed.origin !== targetOrigin;
  } catch {
    return false;
  }
}

let authenticationAcknowledgementTimer;
function checkAuthenticationAcknowledgement() {
  const sealState = authenticationMarkerState(authSealPath, authSealContents);
  if (sealState === "missing") return;
  const ackState = authenticationMarkerState(authAckPath, authAckContents);
  if (sealState !== "valid" || ackState === "invalid") {
    for (const page of guardedPages) closePageFailClosed(page);
    return;
  }
  if (ackState === "valid") {
    clearInterval(authenticationAcknowledgementTimer);
    authenticationAcknowledgementTimer = undefined;
    return;
  }

  let exactTargetPages = 0;
  let unsafePageFound = false;
  let pendingNavigationFound = false;
  for (const page of guardedPages) {
    let pageUnsafe = false;
    try {
      const frameUrls = frameUrlsByPage.get(page);
      const pendingDocumentNavigations = pendingDocumentNavigationsByPage.get(page);
      if (pendingDocumentNavigations?.size) pendingNavigationFound = true;
      let committedTopUrl;
      try {
        committedTopUrl = frameUrls?.get(page.mainFrame());
      } catch {
        committedTopUrl = undefined;
      }
      const currentTopUrl = page.url();
      if (exactTargetReached(committedTopUrl) && exactTargetReached(currentTopUrl)) {
        exactTargetPages += 1;
      }
      else pageUnsafe = true;
      if (frameUrls && [...frameUrls.values()].some(frameHasUnsafeOrigin)) pageUnsafe = true;
    } catch {
      pageUnsafe = true;
    }
    if (pageUnsafe) {
      unsafePageFound = true;
      closePageFailClosed(page);
    }
  }
  if (unsafePageFound || pendingNavigationFound || exactTargetPages === 0) return;
  try {
    publishAuthenticationMarker(
      authAckPath,
      authAckContents,
      "Invalid browser authentication acknowledgement.",
    );
  } catch {
    for (const page of guardedPages) closePageFailClosed(page);
    return;
  }
  clearInterval(authenticationAcknowledgementTimer);
  authenticationAcknowledgementTimer = undefined;
}

function ensureAuthenticationAcknowledgementMonitor() {
  if (authenticationAcknowledgementTimer) return;
  authenticationAcknowledgementTimer = setInterval(checkAuthenticationAcknowledgement, 25);
  authenticationAcknowledgementTimer.unref?.();
}

function exactTargetReached(urlValue) {
  try {
    const parsed = new URL(urlValue);
    parsed.hash = "";
    return parsed.href === targetCompletionUrl;
  } catch {
    return false;
  }
}

function navigationOriginAllowed(urlValue) {
  try {
    const parsed = new URL(urlValue);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.origin === targetOrigin) return true;
    return navigationOrigins.has(parsed.origin) && !authenticationSealed();
  } catch {
    return false;
  }
}

async function abortRoute(route) {
  try {
    await route.abort("blockedbyclient");
  } catch {
    // The request may already have been canceled. It remains fail-closed.
  }
}

async function terminateForNavigationDrift(context, page) {
  if (fatalNavigationTriggered) return;
  fatalNavigationTriggered = true;
  try {
    await context.close();
  } catch {
    try {
      await page.close({ runBeforeUnload: false });
    } catch {
      // A closed page or context is the fail-closed action.
    }
  }
}

async function installContextGuard(context) {
  if (
    !context ||
    context._options?.serviceWorkers !== "block" ||
    typeof context.addInitScript !== "function" ||
    typeof context.serviceWorkers !== "function" ||
    context.serviceWorkers().length !== 0
  ) {
    fail("Service workers are not blocked.");
  }
  await context.addInitScript(({ origins }) => {
    const allowed = new Set(origins);
    const allowedUrl = (value) => {
      try {
        const parsed = new URL(value, document.baseURI);
        return (parsed.protocol === "http:" || parsed.protocol === "https:") && allowed.has(parsed.origin);
      } catch {
        return false;
      }
    };
    const blockUnsafeActivation = (event) => {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      const anchor = path.find((node) => node?.tagName === "A" || node?.tagName === "AREA");
      if (anchor && !allowedUrl(anchor.href)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const blockUnsafeSubmit = (event) => {
      const form = event.target;
      const destination = event.submitter?.formAction || form?.action;
      if (!allowedUrl(destination)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("click", blockUnsafeActivation, true);
    window.addEventListener("auxclick", blockUnsafeActivation, true);
    window.addEventListener("submit", blockUnsafeSubmit, true);
    const originalOpen = window.open.bind(window);
    Object.defineProperty(window, "open", {
      configurable: false,
      enumerable: true,
      writable: false,
      value(url, ...args) {
        if (!allowedUrl(url)) return null;
        return originalOpen(url, ...args);
      },
    });
  }, { origins: [...navigationOrigins] });
  await context.route("**/*", async (route) => {
    let pendingDocumentNavigations;
    let request;
    let navigation = false;
    try {
      request = route.request();
      const owner = request.frame().page();
      navigation = typeof request.isNavigationRequest === "function" &&
        request.isNavigationRequest();
      pendingDocumentNavigations = pendingDocumentNavigationsByPage.get(owner);
      if (navigation) pendingDocumentNavigations?.add(request);
      if (
        !readyPages.has(owner) ||
        !originAllowed(request.url()) ||
        (navigation && !navigationOriginAllowed(request.url()))
      ) {
        if (navigation) pendingDocumentNavigations?.delete(request);
        await abortRoute(route);
        return;
      }
      await route.fallback();
    } catch {
      if (navigation) pendingDocumentNavigations?.delete(request);
      await abortRoute(route);
    }
  });
  await context.routeWebSocket("**/*", async (webSocketRoute) => {
    try {
      if (!originAllowed(webSocketRoute.url(), true)) {
        await webSocketRoute.close({ code: 1008, reason: "Blocked by origin policy" });
        return;
      }
      await webSocketRoute.connectToServer();
    } catch {
      try {
        await webSocketRoute.close({ code: 1008, reason: "Blocked by origin policy" });
      } catch {
        // Closed is the fail-closed state.
      }
    }
  });
  if (context.serviceWorkers().length !== 0) {
    fail("A service worker bypass was detected.");
  }
}

async function installPageGuard(context, page) {
  guardedPages.add(page);
  const frameUrls = new Map();
  const pendingDocumentNavigations = new Set();
  try {
    const frames = typeof page.frames === "function" ? page.frames() : [page.mainFrame()];
    for (const frame of frames) frameUrls.set(frame, frame.url());
  } catch {
    // The top-level page URL remains authoritative if a frame cannot be inspected.
  }
  frameUrlsByPage.set(page, frameUrls);
  pendingDocumentNavigationsByPage.set(page, pendingDocumentNavigations);
  const releaseDocumentNavigation = (request) => {
    pendingDocumentNavigations.delete(request);
  };
  page.on("requestfinished", releaseDocumentNavigation);
  page.on("requestfailed", releaseDocumentNavigation);
  page.on("frameattached", (frame) => {
    try {
      frameUrls.set(frame, frame.url());
    } catch {
      frameUrls.set(frame, "invalid:");
    }
  });
  page.on("framedetached", (frame) => frameUrls.delete(frame));
  page.on("close", () => guardedPages.delete(page));
  ensureAuthenticationAcknowledgementMonitor();
  const session = await context.newCDPSession(page);
  session.on("Fetch.requestPaused", (event) => {
    void (async () => {
      try {
        const documentRequest = event.resourceType === "Document";
        if (
          !originAllowed(event.request?.url) ||
          (documentRequest && !navigationOriginAllowed(event.request?.url))
        ) {
          await session.send("Fetch.failRequest", {
            requestId: event.requestId,
            errorReason: "BlockedByClient",
          });
          return;
        }
        if (event.responseStatusCode !== undefined) {
          if ([301, 302, 303, 307, 308].includes(event.responseStatusCode)) {
            const location = event.responseHeaders?.find(
              (header) => String(header.name).toLowerCase() === "location",
            )?.value;
            let redirectAllowed = false;
            try {
              if (typeof location === "string") {
                const destination = new URL(location, event.request.url).href;
                redirectAllowed = documentRequest
                  ? navigationOriginAllowed(destination)
                  : originAllowed(destination);
              }
            } catch {
              redirectAllowed = false;
            }
            if (!redirectAllowed) {
              await session.send("Fetch.failRequest", {
                requestId: event.requestId,
                errorReason: "BlockedByClient",
              });
              return;
            }
          }
          await session.send("Fetch.continueResponse", { requestId: event.requestId });
        } else {
          await session.send("Fetch.continueRequest", { requestId: event.requestId });
        }
      } catch {
        try {
          await session.send("Fetch.failRequest", {
            requestId: event.requestId,
            errorReason: "BlockedByClient",
          });
        } catch {
          try {
            await page.close({ runBeforeUnload: false });
          } catch {
            // A closed page is fail-closed.
          }
        }
      }
    })();
  });
  await session.send("Fetch.enable", {
    patterns: [
      { urlPattern: "*", requestStage: "Request" },
      { urlPattern: "*", requestStage: "Response" },
    ],
  });
  page.on("framenavigated", (frame) => {
    try {
      const url = frame.url();
      frameUrls.set(frame, url);
      const mainFrame = frame === page.mainFrame();
      let navigationCount = mainFrameNavigationCounts.get(page) ?? 0;
      if (mainFrame) {
        navigationCount += 1;
        mainFrameNavigationCounts.set(page, navigationCount);
      }
      if (
        mainFrame &&
        authMode === "automatic" &&
        credentialSubmitted &&
        credentialPage === page &&
        !credentialPageWasExactTarget &&
        navigationCount > credentialSubmissionNavigation &&
        exactTargetReached(url)
      ) {
        writeAuthenticationSeal();
      }
      if (
        frame === page.mainFrame() &&
        !url.startsWith("chrome-error://") &&
        !navigationOriginAllowed(url)
      ) {
        void terminateForNavigationDrift(context, page);
      }
    } catch {
      void terminateForNavigationDrift(context, page);
    }
  });
  readyPages.add(page);
}

async function installAutomaticLogin(page) {
  let used = false;
  let inProgress = false;
  const handler = async () => {
    if (used || inProgress || loginCompleted) return;
    let currentOrigin;
    try {
      currentOrigin = new URL(page.url()).origin;
    } catch {
      return;
    }
    if (currentOrigin !== loginOrigin) return;
    if (loginInProgress) {
      used = true;
      page.off("domcontentloaded", handler);
      try {
        await page.close({ runBeforeUnload: false });
      } catch {
        // A closed competing page cannot submit credentials.
      }
      return;
    }
    inProgress = true;
    loginInProgress = true;
    let username = loginUsername;
    let password = loginPassword;
    try {
      if (!username || !password) fail("Automatic login credentials are unavailable.");
      credentialPage = page;
      await page.locator(selectors.username).fill(username);
      await page.locator(selectors.password).fill(password);
      credentialSubmissionNavigation = mainFrameNavigationCounts.get(page) ?? 0;
      credentialPageWasExactTarget = exactTargetReached(page.url());
      await page.locator(selectors.submit).click();
      used = true;
      credentialSubmitted = true;
      if (
        !credentialPageWasExactTarget &&
        (mainFrameNavigationCounts.get(page) ?? 0) > credentialSubmissionNavigation &&
        exactTargetReached(page.url())
      ) {
        writeAuthenticationSeal();
      }
      page.off("domcontentloaded", handler);
    } catch {
      used = true;
      page.off("domcontentloaded", handler);
      try {
        await page.close({ runBeforeUnload: false });
      } catch {
        // A closed page is fail-closed.
      }
    } finally {
      loginUsername = undefined;
      loginPassword = undefined;
      username = undefined;
      password = undefined;
      inProgress = false;
      loginInProgress = false;
    }
  };
  page.on("domcontentloaded", handler);
}

module.exports.default = async ({ page }) => {
  if (!page || typeof page.context !== "function" || typeof page.goto !== "function") {
    fail("Invalid browser page.");
  }
  const context = page.context();
  let installed = guardedContexts.get(context);
  if (!installed) {
    installed = installContextGuard(context);
    guardedContexts.set(context, installed);
  }
  await installed;
  await installPageGuard(context, page);
  page.on("download", async (download) => {
    try {
      await download.cancel();
    } catch {
      try {
        await page.close({ runBeforeUnload: false });
      } catch {
        // A closed page is fail-closed.
      }
    }
  });
  if (authMode === "automatic") {
    await installAutomaticLogin(page);
  }
  if (!initialNavigationClaimed) {
    initialNavigationClaimed = true;
    await page.goto(initialTargetUrl, { waitUntil: "domcontentloaded" });
  } else if (
    authenticationMarkerState(authSealPath, authSealContents) === "valid" &&
    authenticationMarkerState(authAckPath, authAckContents) === "valid"
  ) {
    await page.goto(initialTargetUrl, { waitUntil: "domcontentloaded" });
  } else {
    closePageFailClosed(page);
  }
};
