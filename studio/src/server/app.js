import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createRouter } from "./router.js";

const DEFAULT_PUBLIC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../public");

export function handleClientError(
  error,
  socket,
  writeDiagnostic = (line) => process.stderr.write(line),
) {
  const parserCode = typeof error?.code === "string" && /^[A-Z0-9_]{2,64}$/u.test(error.code)
    ? error.code
    : "HTTP_PARSER_ERROR";
  writeDiagnostic(`[manual-video-studio] http-client-error ${parserCode}\n`);
  if (parserCode === "ERR_HTTP_REQUEST_TIMEOUT") {
    socket.destroy();
    return;
  }
  if (!socket.writable) {
    return;
  }
  const body = `${JSON.stringify({
    error: {
      code: "INVALID_HTTP_REQUEST",
      message: "HTTP 요청 형식이 올바르지 않습니다.",
      stage: "server",
      retryable: false,
      artifactPaths: [],
    },
  })}\n`;
  socket.end(
    "HTTP/1.1 400 Bad Request\r\n" +
    "Connection: close\r\n" +
    `Content-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

export function createApp(options = {}) {
  const router = createRouter({
    ...options,
    publicRoot: options.publicRoot ?? DEFAULT_PUBLIC_ROOT,
  });
  const server = createServer((request, response) => {
    void router(request, response);
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.on("clientError", handleClientError);
  return server;
}
