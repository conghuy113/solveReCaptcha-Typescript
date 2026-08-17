// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as ort from "onnxruntime-node";

import {
  DetectionModel,
  calculate4x4Cells,
  detectionTensor,
  nonMaximumSuppression,
} from "../src/inference/detection.js";
import { detectionTargetClass } from "../src/inference/detection-targets.js";
import type { ModelAsset } from "../src/models/types.js";

const detectionAsset: ModelAsset = {
  id: "detection",
  fileName: "yolo12x.onnx",
  url: "https://github.com/example/models/yolo12x.onnx",
  size: 1,
  sha256: "a".repeat(64),
  task: "detect",
  inputName: "images",
  outputName: "output0",
  inputShape: [1, 3, 640, 640],
  outputShape: [1, 84, 8400],
};

test("letterboxes an RGB image into the Python-compatible NCHW tensor", async () => {
  const image = {
    data: Uint8Array.from({ length: 2 * 1 * 3 }, () => 255),
    width: 2,
    height: 1,
  };
  const prepared = await detectionTensor(image);
  assert.deepEqual(prepared.tensor.dims, [1, 3, 640, 640]);
  assert.equal(prepared.ratio, 320);
  assert.equal(prepared.padLeft, 0);
  assert.equal(prepared.padTop, 160);
  const values = prepared.tensor.data as Float32Array;
  assert.ok(Math.abs((values[0] ?? 0) - 114 / 255) < 1e-6);
  assert.equal(values[160 * 640], 1);
});

test("decodes, clips and suppresses target-class boxes like the Python detector", async () => {
  const output = new Float32Array(84 * 2);
  const count = 2;
  for (let prediction = 0; prediction < count; prediction += 1) {
    output[prediction] = prediction === 0 ? 320 : 322;
    output[count + prediction] = 320;
    output[2 * count + prediction] = 320;
    output[3 * count + prediction] = 320;
  }
  output[(4 + 5) * count] = 0.9;
  output[(4 + 5) * count + 1] = 0.8;
  const session = {
    inputNames: ["images"],
    outputNames: ["output0"],
    async run(feeds: Record<string, ort.Tensor>): Promise<Record<string, ort.Tensor>> {
      assert.deepEqual(feeds.images?.dims, [1, 3, 640, 640]);
      return { output0: new ort.Tensor("float32", output, [1, 84, count]) };
    },
  };
  const model = DetectionModel.fromSessionForTests(session, detectionAsset);
  const image = { data: new Uint8Array(450 * 450 * 3), width: 450, height: 450 };
  const detections = await model.detect(image, 5);
  assert.equal(detections.length, 1);
  assert.deepEqual(detections[0]?.box, [112, 112, 337, 337]);
  assert.ok(Math.abs((detections[0]?.confidence ?? 0) - 0.9) < 1e-6);
});

test("maps bounding boxes to all occupied 4x4 cells", () => {
  assert.deepEqual(calculate4x4Cells([10, 10, 100, 100]), [1]);
  assert.deepEqual(calculate4x4Cells([50, 50, 170, 170]), [1, 2, 5, 6]);
  assert.deepEqual(calculate4x4Cells([380, 380, 440, 440]), [16]);
  assert.throws(() => calculate4x4Cells([0, 0, 1, 1], 0), /gridSize/);
});

test("maps multilingual challenge labels to COCO target classes", () => {
  assert.equal(detectionTargetClass(" buses "), 5);
  assert.equal(detectionTargetClass("红绿灯"), 9);
  assert.equal(detectionTargetClass("Feuerhydranten"), 10);
  assert.equal(detectionTargetClass("parquímetros"), 12);
  assert.equal(detectionTargetClass("crosswalks"), undefined);
});

test("NMS keeps stable confidence order", () => {
  const kept = nonMaximumSuppression([
    { box: [0, 0, 100, 100], confidence: 0.8, classId: 5 },
    { box: [5, 5, 100, 100], confidence: 0.9, classId: 5 },
    { box: [200, 200, 250, 250], confidence: 0.7, classId: 5 },
  ]);
  assert.deepEqual(kept.map((item) => item.confidence), [0.9, 0.7]);
});

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const modelPath = join(projectRoot, "yolo12x.onnx");

test(
  "loads and executes the real detection model when the local asset is available",
  { skip: !existsSync(modelPath), timeout: 60_000 },
  async () => {
    const model = await DetectionModel.create(modelPath);
    const image = { data: new Uint8Array(450 * 450 * 3), width: 450, height: 450 };
    assert.deepEqual(await model.detect(image, 5), []);
  },
);
