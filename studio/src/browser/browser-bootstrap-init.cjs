"use strict";

const guardedContexts = new WeakMap();
const readyPages = new WeakSet();
const credentialKeys = [
  "MANUAL_STUDIO_LOGIN_USERNAME",
  "MANUAL_STUDIO_LOGIN_PASSWORD",
];

function fail(message) {
  throw new Error(message);
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
} catch {
  fail("Invalid browser target URL.");
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
    return allowedOrigins.has(parsed.origin);
  } catch {
    return false;
  }
}

function navigationOriginAllowed(urlValue) {
  try {
    const parsed = new URL(urlValue);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && navigationOrigins.has(parsed.origin);
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
    try {
      const request = route.request();
      const owner = request.frame().page();
      if (!readyPages.has(owner) || !originAllowed(request.url())) {
        await abortRoute(route);
        return;
      }
      await route.fallback();
    } catch {
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
  const session = await context.newCDPSession(page);
  session.on("Fetch.requestPaused", (event) => {
    void (async () => {
      try {
        if (!originAllowed(event.request?.url)) {
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
              redirectAllowed =
                typeof location === "string" &&
                originAllowed(new URL(location, event.request.url).href);
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
      await page.locator(selectors.username).fill(username);
      await page.locator(selectors.password).fill(password);
      await page.locator(selectors.submit).click();
      used = true;
      loginCompleted = true;
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
  }
};
