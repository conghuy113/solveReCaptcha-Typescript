// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as ort from "onnxruntime-node";

import {
  CLASS_NAMES,
  ClassificationModel,
  classificationTensor,
  splitRgbGrid,
} from "../src/inference/classification.js";
import type { ModelAsset } from "../src/models/types.js";

const classificationAsset: ModelAsset = {
  id: "classification",
  fileName: "recaptcha_classification_57k.onnx",
  url: "https://github.com/example/models/classification.onnx",
  size: 1,
  sha256: "a".repeat(64),
  task: "classify",
  inputName: "images",
  outputName: "output0",
  inputShape: ["batch", 3, "height", "width"],
  outputShape: ["batch", 14],
};

test("builds normalized RGB NCHW tensors with the Python model shape", async () => {
  const red = { data: Uint8Array.from([255, 0, 0, 255, 0, 0]), width: 2, height: 1 };
  const blue = { data: Uint8Array.from([0, 0, 255, 0, 0, 255]), width: 1, height: 2 };
  const tensor = await classificationTensor([red, blue]);
  assert.deepEqual(tensor.dims, [2, 3, 640, 640]);
  const values = tensor.data as Float32Array;
  const area = 640 * 640;
  assert.equal(values[0], 1);
  assert.equal(values[area], 0);
  assert.equal(values[2 * area], 0);
  const second = 3 * area;
  assert.equal(values[second], 0);
  assert.equal(values[second + area], 0);
  assert.equal(values[second + 2 * area], 1);
});

test("splits RGB grids using the same integer cell boundaries as Python", () => {
  const pixels = Uint8Array.from({ length: 6 * 4 * 3 }, (_, index) => index % 251);
  const tiles = splitRgbGrid({ data: pixels, width: 6, height: 4 }, 2);
  assert.equal(tiles.length, 4);
  assert.deepEqual(tiles.map((tile) => [tile.width, tile.height]), [
    [3, 2],
    [3, 2],
    [3, 2],
    [3, 2],
  ]);
  assert.deepEqual(Array.from(tiles[0]!.data.subarray(0, 9)), Array.from(pixels.subarray(0, 9)));
  assert.deepEqual(Array.from(tiles[1]!.data.subarray(0, 9)), Array.from(pixels.subarray(9, 18)));
});

test("runs batched classification and maps target confidences", async () => {
  const outputs = new Float32Array(2 * CLASS_NAMES.length);
  outputs[2] = 0.9;
  outputs[CLASS_NAMES.length + 2] = 0.25;
  outputs[CLASS_NAMES.length + 3] = 0.75;
  const session = {
    inputNames: ["images"],
    outputNames: ["output0"],
    async run(feeds: Record<string, ort.Tensor>): Promise<Record<string, ort.Tensor>> {
      assert.deepEqual(feeds.images?.dims, [2, 3, 640, 640]);
      return { output0: new ort.Tensor("float32", outputs, [2, CLASS_NAMES.length]) };
    },
  };
  const model = ClassificationModel.fromSessionForTests(session, classificationAsset);
  const images = [
    { data: new Uint8Array([255, 0, 0]), width: 1, height: 1 },
    { data: new Uint8Array([0, 0, 255]), width: 1, height: 1 },
  ];
  const confidences = await model.targetConfidences(images, 2);
  assert.ok(Math.abs((confidences[0] ?? 0) - 0.9) < 1e-6);
  assert.ok(Math.abs((confidences[1] ?? 0) - 0.25) < 1e-6);
  await assert.rejects(model.targetConfidences(images, 14), /targetClass/);
});

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const modelPath = join(
  projectRoot,
  "src",
  "vision_ai_recaptcha_solver",
  "models",
  "recaptcha_classification_57k.onnx",
);
const imagePath = join(projectRoot, "src", "vision_ai_recaptcha_solver", "assets", "bus.jpg");

test(
  "matches the Python classification oracle on the real ONNX model",
  { skip: !existsSync(modelPath) },
  async () => {
    const goldenPath = fileURLToPath(
      new URL("./fixtures/classification-bus-python.json", import.meta.url),
    );
    const golden = JSON.parse(await readFile(goldenPath, "utf8")) as {
      probabilities: number[];
      classId: number;
    };
    const model = await ClassificationModel.create(modelPath);
    const result = await model.classify(await readFile(imagePath));
    assert.equal(result.classId, golden.classId);
    const maximumDifference = Math.max(
      ...golden.probabilities.map((expected, index) =>
        Math.abs(expected - (result.probabilities[index] ?? 0)),
      ),
    );
    assert.ok(maximumDifference < 0.01, `maximum Python/TypeScript delta: ${String(maximumDifference)}`);
  },
);
