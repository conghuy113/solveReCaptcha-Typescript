// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import * as publicApi from "../src/index.js";

test("exports exactly one runtime function", () => {
  assert.deepEqual(Object.keys(publicApi), ["solveReCaptcha"]);
  assert.equal(typeof publicApi.solveReCaptcha, "function");
});
