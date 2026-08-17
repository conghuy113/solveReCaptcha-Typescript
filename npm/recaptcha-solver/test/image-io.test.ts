// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  compositeRgbGridImage,
  downloadChallengeImage,
} from "../src/challenge/image-io.js";

const payloadUrl = "https://www.google.com/recaptcha/api2/payload?id=test";

test("downloads an HTTPS reCAPTCHA image and retries bounded failures", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const fetchImage = (async () => {
    calls += 1;
    if (calls === 1) return new Response("temporary", { status: 503 });
    return new Response(Uint8Array.from([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/jpeg", "content-length": "3" },
    });
  }) as typeof fetch;
  const image = await downloadChallengeImage(payloadUrl, {
    retries: 1,
    retryDelayMs: 1,
    fetch: fetchImage,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
  });
  assert.deepEqual(image, Buffer.from([1, 2, 3]));
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [500]);
});

test("rejects untrusted endpoints, non-images and oversized responses", async () => {
  await assert.rejects(
    downloadChallengeImage("http://127.0.0.1/recaptcha/api2/payload"),
    /trusted reCAPTCHA endpoint/,
  );
  await assert.rejects(
    downloadChallengeImage("https://example.com/recaptcha/api2/payload"),
    /trusted reCAPTCHA endpoint/,
  );
  await assert.rejects(
    downloadChallengeImage(payloadUrl, {
      retries: 0,
      fetch: (async () => new Response("not an image", {
        headers: { "content-type": "text/plain" },
      })) as typeof fetch,
    }),
    /Unexpected challenge image content type/,
  );
  await assert.rejects(
    downloadChallengeImage(payloadUrl, {
      retries: 0,
      maxBytes: 2,
      fetch: (async () => new Response(Uint8Array.from([1, 2, 3]), {
        headers: { "content-type": "image/png" },
      })) as typeof fetch,
    }),
    /exceeds the 2 byte limit/,
  );
});

test("composites an RGB image into a 1-indexed grid cell without touching other cells", async () => {
  const main = { data: new Uint8Array(4 * 4 * 3), width: 4, height: 4 };
  const red = { data: Uint8Array.from([255, 0, 0]), width: 1, height: 1 };
  const result = await compositeRgbGridImage(main, red, 2, 2);
  const pixel = (x: number, y: number): number[] => {
    const offset = (y * result.width + x) * 3;
    return Array.from(result.data.subarray(offset, offset + 3));
  };
  assert.deepEqual(pixel(0, 0), [0, 0, 0]);
  assert.deepEqual(pixel(2, 0), [255, 0, 0]);
  assert.deepEqual(pixel(3, 1), [255, 0, 0]);
  assert.deepEqual(pixel(2, 2), [0, 0, 0]);
  await assert.rejects(compositeRgbGridImage(main, red, 0, 2), /cell/);
});
