// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateModelManifest } from "../src/models/manifest.js";
import { ensureModels } from "../src/models/manager.js";
import type { ModelAsset, ModelManifest } from "../src/models/types.js";

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function asset(
  id: "classification" | "detection",
  body: Buffer,
  baseUrl: string,
): ModelAsset {
  return {
    id,
    fileName: id === "classification" ? "recaptcha_classification_57k.onnx" : "yolo12x.onnx",
    url: `${baseUrl}/${id}.onnx`,
    size: body.byteLength,
    sha256: sha256(body),
    task: id === "classification" ? "classify" : "detect",
    inputName: "images",
    outputName: "output0",
    inputShape: [1, 3, 640, 640],
    outputShape: id === "classification" ? [1, 14] : [1, 84, 8400],
  };
}

function manifest(baseUrl: string, classification: Buffer, detection: Buffer): ModelManifest {
  return {
    schemaVersion: 1,
    modelSetVersion: "1.0.0",
    releaseTag: "models-v1.0.0",
    license: "AGPL-3.0-only",
    models: [
      asset("classification", classification, baseUrl),
      asset("detection", detection, baseUrl),
    ],
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server has no TCP address.");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("validates immutable two-model manifests and rejects unsafe paths", () => {
  const valid = {
    schemaVersion: 1,
    modelSetVersion: "1.0.0",
    releaseTag: "models-v1.0.0",
    license: "AGPL-3.0-only",
    models: [
      {
        id: "classification",
        fileName: "recaptcha_classification_57k.onnx",
        url: "https://github.com/example/release/classification.onnx",
        size: 10,
        sha256: "a".repeat(64),
        task: "classify",
        inputName: "images",
        outputName: "output0",
        inputShape: ["batch", 3, "height", "width"],
        outputShape: ["batch", 14],
      },
      {
        id: "detection",
        fileName: "yolo12x.onnx",
        url: "https://github.com/example/release/detection.onnx",
        size: 20,
        sha256: "b".repeat(64),
        task: "detect",
        inputName: "images",
        outputName: "output0",
        inputShape: [1, 3, 640, 640],
        outputShape: [1, 84, 8400],
      },
    ],
  };
  assert.equal(validateModelManifest(valid).models.length, 2);
  const unsafe = structuredClone(valid);
  unsafe.models[0]!.fileName = "../classification.onnx";
  assert.throws(() => validateModelManifest(unsafe), /Unsafe model file name/);
  const insecure = structuredClone(valid);
  insecure.models[0]!.url = "http://github.com/classification.onnx";
  assert.throws(() => validateModelManifest(insecure), /must use HTTPS/);
});

test("downloads, hashes, atomically caches, and reuses both models", async () => {
  const classification = Buffer.from("classification-model");
  const detection = Buffer.from("detection-model");
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    const body = request.url === "/classification.onnx" ? classification : detection;
    response.writeHead(200, { "content-length": String(body.byteLength) });
    response.end(body);
  });
  const port = await listen(server);
  const cacheDirectory = mkdtempSync(join(tmpdir(), "recaptcha-model-cache-"));
  try {
    const options = {
      manifest: manifest(`http://127.0.0.1:${String(port)}`, classification, detection),
      cacheDirectory,
      allowedHosts: new Set(["127.0.0.1"]),
      allowInsecureForTests: true,
      downloadTimeoutMs: 5_000,
      lockTimeoutMs: 5_000,
    };
    const first = await ensureModels(options);
    assert.equal(requests, 2);
    assert.ok(existsSync(first.classification));
    assert.ok(existsSync(first.detection));
    assert.equal(readdirSync(cacheDirectory).some((name) => name.endsWith(".tmp")), false);

    const second = await ensureModels(options);
    assert.equal(second.directory, first.directory);
    assert.equal(requests, 2, "verified cache must avoid network requests");
  } finally {
    await close(server);
    rmSync(cacheDirectory, { recursive: true, force: true });
  }
});

test("rejects corrupt downloads and leaves no model or temporary file", async () => {
  const expected = Buffer.from("expected-model");
  const corrupt = Buffer.from("corrupted-mode");
  const detection = Buffer.from("detection-model");
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-length": String(corrupt.byteLength) });
    response.end(corrupt);
  });
  const port = await listen(server);
  const cacheDirectory = mkdtempSync(join(tmpdir(), "recaptcha-corrupt-cache-"));
  try {
    await assert.rejects(
      ensureModels({
        manifest: manifest(`http://127.0.0.1:${String(port)}`, expected, detection),
        cacheDirectory,
        allowedHosts: new Set(["127.0.0.1"]),
        allowInsecureForTests: true,
        downloadTimeoutMs: 5_000,
        lockTimeoutMs: 5_000,
      }),
      /Could not download verified model classification/,
    );
    assert.equal(requests, 3, "corrupt downloads should retry a bounded number of times");
    assert.equal(existsSync(join(cacheDirectory, "recaptcha_classification_57k.onnx")), false);
    assert.deepEqual(readdirSync(cacheDirectory), []);
  } finally {
    await close(server);
    rmSync(cacheDirectory, { recursive: true, force: true });
  }
});
