import assert from "node:assert/strict";
import test from "node:test";
import { ReadableStream } from "node:stream/web";
import azureFunctions from "@azure/functions";
const { HttpRequest } = azureFunctions;
import {
  MAX_HTTP_BODY_BYTES,
  readBoundedJsonObject,
} from "../src/http-body.js";

function request(text: string, headers?: Record<string, string>) {
  return new HttpRequest({
    url: "https://example.invalid/messages",
    method: "POST",
    headers,
    body: { string: text },
  });
}

test("accepts an Azure request at the exact UTF-8 byte limit", async () => {
  const prefix = '{"text":"';
  const suffix = '"}';
  const text =
    "é".repeat((MAX_HTTP_BODY_BYTES - prefix.length - suffix.length - 1) / 2) +
    "x";
  const body = prefix + text + suffix;
  assert.equal(Buffer.byteLength(body), MAX_HTTP_BODY_BYTES);
  assert.deepEqual((await readBoundedJsonObject(request(body))).body, { text });
});

for (const length of [undefined, "2"]) {
  test(`counts chunked bytes with content-length ${length} and cancels overflow`, async () => {
    let pulls = 0;
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(16 * 1024).fill(32));
        },
        cancel() {
          cancellations++;
        },
      },
      { highWaterMark: 0 },
    );
    const headers = new Headers(
      length === undefined ? {} : { "content-length": length },
    );
    assert.equal(
      (await readBoundedJsonObject({ headers, body })).response?.status,
      413,
    );
    assert.equal(pulls, 17);
    assert.equal(cancellations, 1);
    assert.equal(body.locked, false);
  });
}

test("rejects declared oversize without reading the producer", async () => {
  let pulls = 0;
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        pulls++;
      },
      cancel() {
        cancellations++;
      },
    },
    { highWaterMark: 0 },
  );
  const headers = new Headers({
    "content-length": String(MAX_HTTP_BODY_BYTES + 1),
  });
  assert.equal(
    (await readBoundedJsonObject({ headers, body })).response?.status,
    413,
  );
  assert.equal(pulls, 0);
  assert.equal(cancellations, 1);
});

for (const body of ["{", "null", "[]", '"text"', "0", ""]) {
  test(`rejects invalid/non-object input ${JSON.stringify(body)}`, async () => {
    const response = (await readBoundedJsonObject(request(body))).response;
    assert.equal(response?.status, 400);
    assert.equal((response?.jsonBody as { success: boolean }).success, false);
  });
}

test("rejects invalid UTF-8 without replacement decoding", async () => {
  const input = new HttpRequest({
    url: "https://example.invalid/messages",
    method: "POST",
    body: { bytes: new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125]) },
  });
  assert.equal((await readBoundedJsonObject(input)).response?.status, 400);
});

test("returns a safe 400 for an interrupted stream", async () => {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("private producer detail"));
    },
  });
  const result = await readBoundedJsonObject({ headers: new Headers(), body });
  assert.equal(result.response?.status, 400);
  assert.equal(
    JSON.stringify(result).includes("private producer detail"),
    false,
  );
  assert.equal(body.locked, false);
});
