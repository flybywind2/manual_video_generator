import assert from "node:assert/strict";
import test from "node:test";

import { handleClientError } from "../../src/server/app.js";

function fakeSocket({ writable = true } = {}) {
  const calls = [];
  return {
    calls,
    writable,
    destroy() {
      calls.push(["destroy"]);
    },
    end(value) {
      calls.push(["end", value]);
    },
  };
}

test("HTTP request timeouts close an unparsed browser socket without an unsolicited response", () => {
  const socket = fakeSocket();
  const diagnostics = [];

  handleClientError(
    Object.assign(new Error("private parser detail"), { code: "ERR_HTTP_REQUEST_TIMEOUT" }),
    socket,
    (line) => diagnostics.push(line),
  );

  assert.deepEqual(socket.calls, [["destroy"]]);
  assert.deepEqual(diagnostics, [
    "[manual-video-studio] http-client-error ERR_HTTP_REQUEST_TIMEOUT\n",
  ]);
  assert.equal(JSON.stringify(diagnostics).includes("private parser detail"), false);
});

test("other malformed HTTP requests retain the bounded local 400 response", () => {
  const socket = fakeSocket();

  handleClientError({ code: "HPE_INVALID_METHOD" }, socket, () => {});

  assert.equal(socket.calls.length, 1);
  assert.equal(socket.calls[0][0], "end");
  assert.match(socket.calls[0][1], /^HTTP\/1\.1 400 Bad Request\r\n/u);
  assert.match(socket.calls[0][1], /INVALID_HTTP_REQUEST/u);
});
