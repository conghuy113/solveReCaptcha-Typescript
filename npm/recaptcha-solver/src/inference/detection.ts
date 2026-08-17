// SPDX-License-Identifier: AGPL-3.0-only

import * as ort from "onnxruntime-node";
import sharp from "sharp";

import { decodeRgbImage } from "./classification.js";
import { loadModelManifest } from "../models/manifest.js";
import type { ModelAsset } from "../models/types.js";
import type { ClassificationImage } from "./classification.js";

export const DETECTION_SIZE = 640;
export const DEFAULT_DETECTION_CONFIDENCE = 0.6;
export const DEFAULT_NMS_THRESHOLD = 0.45;

export type BoundingBox = readonly [x1: number, y1: number, x2: number, y2: number];

export interface Detection {
  box: BoundingBox;
  confidence: number;
  classId: number;
}

export interface DetectionOptions {
  confidenceThreshold?: number;
  nmsThreshold?: number;
}

export interface DetectionTensor {
  tensor: ort.Tensor;
  ratio: number;
  padLeft: number;
  padTop: number;
  sourceWidth: number;
  sourceHeight: number;
}

interface SessionLike {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, ort.Tensor>): Promise<Record<string, ort.Tensor>>;
}

function roundHalfToEven(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

function threshold(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1) {
    throw new TypeError(`${name} must be between 0 and 1.`);
  }
  return resolved;
}

export async function detectionTensor(image: ClassificationImage): Promise<DetectionTensor> {
  const source = await decodeRgbImage(image);
  const ratio = Math.min(DETECTION_SIZE / source.height, DETECTION_SIZE / source.width);
  const resizedWidth = Math.max(1, roundHalfToEven(source.width * ratio));
  const resizedHeight = Math.max(1, roundHalfToEven(source.height * ratio));
  const padLeft = roundHalfToEven((DETECTION_SIZE - resizedWidth) / 2 - 0.1);
  const padTop = roundHalfToEven((DETECTION_SIZE - resizedHeight) / 2 - 0.1);
  const pixels = await sharp(Buffer.from(source.data), {
    raw: { width: source.width, height: source.height, channels: 3 },
  })
    .resize(resizedWidth, resizedHeight, { fit: "fill", kernel: sharp.kernel.linear })
    .extend({
      left: padLeft,
      top: padTop,
      right: DETECTION_SIZE - resizedWidth - padLeft,
      bottom: DETECTION_SIZE - resizedHeight - padTop,
      background: { r: 114, g: 114, b: 114 },
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (
    pixels.info.width !== DETECTION_SIZE ||
    pixels.info.height !== DETECTION_SIZE ||
    pixels.info.channels !== 3
  ) {
    throw new Error("Detection preprocessing returned an unexpected image shape.");
  }

  const area = DETECTION_SIZE * DETECTION_SIZE;
  const nchw = new Float32Array(3 * area);
  for (let index = 0; index < area; index += 1) {
    const pixel = index * 3;
    nchw[index] = (pixels.data[pixel] ?? 0) / 255;
    nchw[area + index] = (pixels.data[pixel + 1] ?? 0) / 255;
    nchw[2 * area + index] = (pixels.data[pixel + 2] ?? 0) / 255;
  }

  return {
    tensor: new ort.Tensor("float32", nchw, [1, 3, DETECTION_SIZE, DETECTION_SIZE]),
    ratio,
    padLeft,
    padTop,
    sourceWidth: source.width,
    sourceHeight: source.height,
  };
}

function intersectionOverUnion(left: BoundingBox, right: BoundingBox): number {
  const x1 = Math.max(left[0], right[0]);
  const y1 = Math.max(left[1], right[1]);
  const x2 = Math.min(left[2], right[2]);
  const y2 = Math.min(left[3], right[3]);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const leftArea = Math.max(0, left[2] - left[0]) * Math.max(0, left[3] - left[1]);
  const rightArea = Math.max(0, right[2] - right[0]) * Math.max(0, right[3] - right[1]);
  const union = leftArea + rightArea - intersection;
  return union > 0 ? intersection / union : 0;
}

export function nonMaximumSuppression(
  detections: readonly Detection[],
  nmsThreshold = DEFAULT_NMS_THRESHOLD,
): Detection[] {
  threshold(nmsThreshold, DEFAULT_NMS_THRESHOLD, "nmsThreshold");
  const pending = detections
    .map((detection, index) => ({ detection, index }))
    .sort((left, right) =>
      right.detection.confidence - left.detection.confidence || left.index - right.index,
    );
  const kept: Detection[] = [];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) break;
    kept.push(current.detection);
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const candidate = pending[index];
      if (candidate && intersectionOverUnion(current.detection.box, candidate.detection.box) > nmsThreshold) {
        pending.splice(index, 1);
      }
    }
  }
  return kept;
}

export function calculate4x4Cells(box: BoundingBox, gridSize = 450): number[] {
  if (!Number.isFinite(gridSize) || gridSize <= 0) {
    throw new TypeError("gridSize must be positive.");
  }
  const cellSize = gridSize / 4;
  const points: ReadonlyArray<readonly [number, number]> = [
    [box[0], box[1]],
    [box[2], box[1]],
    [box[0], box[3]],
    [box[2], box[3]],
  ];
  const cells = points.flatMap(([x, y]) => {
    if (x < 0 || x > gridSize || y < 0 || y > gridSize) return [];
    const column = Math.min(3, Math.floor(x / cellSize));
    const row = Math.min(3, Math.floor(y / cellSize));
    return [row * 4 + column + 1];
  });
  if (cells.length === 0) return [];
  const coordinates = cells.map((cell) => [Math.floor((cell - 1) / 4), (cell - 1) % 4] as const);
  const rows = coordinates.map(([row]) => row);
  const columns = coordinates.map(([, column]) => column);
  const result: number[] = [];
  for (let row = Math.min(...rows); row <= Math.max(...rows); row += 1) {
    for (let column = Math.min(...columns); column <= Math.max(...columns); column += 1) {
      result.push(row * 4 + column + 1);
    }
  }
  return result;
}

export class DetectionModel {
  readonly #session: SessionLike;
  readonly #asset: ModelAsset;

  private constructor(session: SessionLike, asset: ModelAsset) {
    this.#session = session;
    this.#asset = asset;
    if (!session.inputNames.includes(asset.inputName)) {
      throw new Error(`Detection model has no input named ${asset.inputName}.`);
    }
    if (!session.outputNames.includes(asset.outputName)) {
      throw new Error(`Detection model has no output named ${asset.outputName}.`);
    }
  }

  static async create(modelPath: string): Promise<DetectionModel> {
    const manifest = await loadModelManifest();
    const asset = manifest.models.find((model) => model.id === "detection");
    if (!asset) throw new Error("Detection model is missing from the manifest.");
    const session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
      logSeverityLevel: 3,
    });
    return new DetectionModel(session, asset);
  }

  static fromSessionForTests(session: SessionLike, asset: ModelAsset): DetectionModel {
    return new DetectionModel(session, asset);
  }

  async detect(
    image: ClassificationImage,
    targetClass: number,
    options: DetectionOptions = {},
  ): Promise<Detection[]> {
    if (!Number.isInteger(targetClass) || targetClass < 0) {
      throw new TypeError("targetClass must be a non-negative integer.");
    }
    const confidenceThreshold = threshold(
      options.confidenceThreshold,
      DEFAULT_DETECTION_CONFIDENCE,
      "confidenceThreshold",
    );
    const nmsThreshold = threshold(options.nmsThreshold, DEFAULT_NMS_THRESHOLD, "nmsThreshold");
    const prepared = await detectionTensor(image);
    const outputs = await this.#session.run({ [this.#asset.inputName]: prepared.tensor });
    const output = outputs[this.#asset.outputName];
    if (!output) throw new Error(`Detection output is missing: ${this.#asset.outputName}.`);
    if (output.dims.length !== 3 || output.dims[0] !== 1) {
      throw new Error(`Unexpected detection output shape: ${output.dims.join("x")}.`);
    }
    const attributes = output.dims[1];
    const predictionCount = output.dims[2];
    if (!attributes || !predictionCount || targetClass + 4 >= attributes) return [];
    const values = output.data as ArrayLike<number>;
    const detections: Detection[] = [];
    for (let prediction = 0; prediction < predictionCount; prediction += 1) {
      const confidence = Number(values[(targetClass + 4) * predictionCount + prediction] ?? 0);
      if (confidence < confidenceThreshold) continue;
      const centerX = Number(values[prediction] ?? 0);
      const centerY = Number(values[predictionCount + prediction] ?? 0);
      const width = Number(values[2 * predictionCount + prediction] ?? 0);
      const height = Number(values[3 * predictionCount + prediction] ?? 0);
      const x1 = Math.max(0, (centerX - width / 2 - prepared.padLeft) / prepared.ratio);
      const y1 = Math.max(0, (centerY - height / 2 - prepared.padTop) / prepared.ratio);
      const x2 = Math.min(
        prepared.sourceWidth,
        (centerX + width / 2 - prepared.padLeft) / prepared.ratio,
      );
      const y2 = Math.min(
        prepared.sourceHeight,
        (centerY + height / 2 - prepared.padTop) / prepared.ratio,
      );
      if (x2 <= x1 || y2 <= y1) continue;
      detections.push({
        box: [Math.trunc(x1), Math.trunc(y1), Math.trunc(x2), Math.trunc(y2)],
        confidence,
        classId: targetClass,
      });
    }
    return nonMaximumSuppression(detections, nmsThreshold);
  }

  async detectGridCells(
    image: ClassificationImage,
    targetClass: number,
    gridSize = 450,
    options: DetectionOptions = {},
  ): Promise<number[]> {
    const detections = await this.detect(image, targetClass, options);
    const cells = new Set(detections.flatMap((detection) => calculate4x4Cells(detection.box, gridSize)));
    return [...cells].sort((left, right) => left - right);
  }
}
