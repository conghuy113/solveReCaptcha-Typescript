import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateNativePackage } from "../src/platform.js";
import { mapSolveResult, validateWorkerStatus, WorkerClient } from "../src/worker-client.js";

test("maps the Python worker result to the public TypeScript shape", () => {
  const result = mapSolveResult({
    status: "success",
    message: "Captcha solved successfully.",
    click_checkbox: false,
    token: "token-value",
    captcha_type: "dynamic_3x3",
    attempts: 2,
    time_taken: 4.25,
    cookies: [{ name: "session", value: "cookie" }],
    current_url: "https://example.com/signup",
    completion_reason: "token_found",
  });

  assert.equal(result.clickCheckbox, false);
  assert.equal(result.captchaType, "dynamic_3x3");
  assert.equal(result.timeTaken, 4.25);
  assert.equal(result.completionReason, "token_found");
});

test("rejects malformed worker results", () => {
  assert.throws(() => mapSolveResult({ status: "success" }), /token/);
});

test("validates every required solveReCaptcha option before spawning", async () => {
  const worker = new WorkerClient("does-not-exist");

  await assert.rejects(
    worker.solveReCaptcha({
      targetUrl: "https://example.com",
      port: 0,
      clickCheckbox: false,
    }),
    /port must be an integer between 1 and 65535/,
  );
  await assert.rejects(
    worker.solveReCaptcha({
      targetUrl: "",
      port: 9222,
      clickCheckbox: true,
    }),
    /targetUrl must be a non-empty string/,
  );
});

test("validates the frozen worker protocol handshake", () => {
  assert.doesNotThrow(() =>
    validateWorkerStatus({ protocol_version: 1, frozen: true, worker_pid: 123 }),
  );
  assert.throws(
    () => validateWorkerStatus({ protocol_version: 2, frozen: true, worker_pid: 123 }),
    /does not match SDK protocol/,
  );
  assert.throws(
    () => validateWorkerStatus({ protocol_version: 1, frozen: false, worker_pid: 123 }),
    /not a frozen native binary/,
  );
});

test("validates native package metadata and executable checksum", () => {
  const packageRoot = mkdtempSync(join(tmpdir(), "recaptcha-native-package-"));
  try {
    const executableDirectory = join(packageRoot, "bin", "recaptcha-solver-worker");
    mkdirSync(executableDirectory, { recursive: true });
    const executablePath = join(executableDirectory, "recaptcha-solver-worker");
    const executableContent = "native-worker";
    writeFileSync(executablePath, executableContent);
    chmodSync(executablePath, 0o755);
    writeFileSync(
      join(packageRoot, "build-info.json"),
      JSON.stringify({
        schemaVersion: 1,
        protocolVersion: 1,
        package: "@conghuy113/recaptcha-solver-linux-x64",
        platform: "linux-x64",
        executable: "bin/recaptcha-solver-worker/recaptcha-solver-worker",
      }),
    );
    writeFileSync(
      join(packageRoot, "checksums.json"),
      JSON.stringify({
        "bin/recaptcha-solver-worker/recaptcha-solver-worker": createHash("sha256")
          .update(executableContent)
          .digest("hex"),
      }),
    );

    assert.equal(
      validateNativePackage(packageRoot, "linux-x64", {
        packageName: "@conghuy113/recaptcha-solver-linux-x64",
        executableName: "recaptcha-solver-worker",
      }),
      executablePath,
    );

    writeFileSync(executablePath, "tampered");
    assert.throws(
      () =>
        validateNativePackage(packageRoot, "linux-x64", {
          packageName: "@conghuy113/recaptcha-solver-linux-x64",
          executableName: "recaptcha-solver-worker",
        }),
      /checksum verification failed/,
    );
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
});
