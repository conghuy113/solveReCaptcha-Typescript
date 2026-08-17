// SPDX-License-Identifier: AGPL-3.0-only

import * as ort from "onnxruntime-node";
import sharp from "sharp";

import { loadModelManifest } from "../models/manifest.js";
import type { ModelAsset } from "../models/types.js";

export const CLASSIFICATION_SIZE = 640;
export const CLASS_NAMES = [
  "Bicycle",
  "Bridge",
  "Bus",
  "Car",
  "Chimney",
  "Crosswalk",
  "Hydrant",
  "Motorcycle",
  "Mountain",
  "Other",
  "Palm",
  "Stair",
  "Tractor",
  "Traffic Light",
] as const;

export interface RawRgbImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export type ClassificationImage = Buffer | RawRgbImage;

export interface ClassificationResult {
  classId: number;
  className: string;
  confidence: number;
  probabilities: Float32Array;
}

interface SessionLike {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, ort.Tensor>): Promise<Record<string, ort.Tensor>>;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer.`);
  return value;
}

function roundHalfToEven(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

function validateRawImage(image: RawRgbImage): RawRgbImage {
  const width = positiveInteger(image.width, "image.width");
  const height = positiveInteger(image.height, "image.height");
  if (!(image.data instanceof Uint8Array)) throw new TypeError("image.data must be a Uint8Array.");
  if (image.data.byteLength !== width * height * 3) {
    throw new TypeError(
      `RGB image contains ${String(image.data.byteLength)} bytes; expected ${String(width * height * 3)}.`,
    );
  }
  return { data: image.data, width, height };
}

export async function decodeRgbImage(image: ClassificationImage): Promise<RawRgbImage> {
  if (!Buffer.isBuffer(image)) return validateRawImage(image);
  if (image.byteLength === 0) throw new TypeError("Encoded image must not be empty.");
  const decoded = await sharp(image)
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (decoded.info.channels !== 3) {
    throw new Error(`Decoded image has ${String(decoded.info.channels)} channels; expected RGB.`);
  }
  return {
    data: decoded.data,
    width: decoded.info.width,
    height: decoded.info.height,
  };
}

async function resizeAndCenterCrop(image: RawRgbImage): Promise<Buffer> {
  const scale = CLASSIFICATION_SIZE / Math.min(image.width, image.height);
  const width = Math.max(CLASSIFICATION_SIZE, roundHalfToEven(image.width * scale));
  const height = Math.max(CLASSIFICATION_SIZE, roundHalfToEven(image.height * scale));
  const left = Math.floor((width - CLASSIFICATION_SIZE) / 2);
  const top = Math.floor((height - CLASSIFICATION_SIZE) / 2);
  const result = await sharp(Buffer.from(image.data), {
    raw: { width: image.width, height: image.height, channels: 3 },
  })
    .resize(width, height, { fit: "fill", kernel: sharp.kernel.linear })
    .extract({ left, top, width: CLASSIFICATION_SIZE, height: CLASSIFICATION_SIZE })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (
    result.info.width !== CLASSIFICATION_SIZE ||
    result.info.height !== CLASSIFICATION_SIZE ||
    result.info.channels !== 3
  ) {
    throw new Error("Classification preprocessing returned an unexpected image shape.");
  }
  return result.data;
}

export async function classificationTensor(images: ClassificationImage[]): Promise<ort.Tensor> {
  if (images.length === 0) throw new TypeError("At least one classification image is required.");
  const area = CLASSIFICATION_SIZE * CLASSIFICATION_SIZE;
  const output = new Float32Array(images.length * 3 * area);
  for (let batch = 0; batch < images.length; batch += 1) {
    const input = images[batch];
    if (!input) throw new TypeError(`Classification image ${String(batch)} is missing.`);
    const raw = await decodeRgbImage(input);
    const pixels = await resizeAndCenterCrop(raw);
    const batchOffset = batch * 3 * area;
    for (let index = 0; index < area; index += 1) {
      const pixelOffset = index * 3;
      output[batchOffset + index] = (pixels[pixelOffset] ?? 0) / 255;
      output[batchOffset + area + index] = (pixels[pixelOffset + 1] ?? 0) / 255;
      output[batchOffset + 2 * area + index] = (pixels[pixelOffset + 2] ?? 0) / 255;
    }
  }
  return new ort.Tensor("float32", output, [images.length, 3, CLASSIFICATION_SIZE, CLASSIFICATION_SIZE]);
}

export function splitRgbGrid(image: RawRgbImage, gridSize: number): RawRgbImage[] {
  const source = validateRawImage(image);
  positiveInteger(gridSize, "gridSize");
  const tileWidth = Math.floor(source.width / gridSize);
  const tileHeight = Math.floor(source.height / gridSize);
  if (tileWidth < 1 || tileHeight < 1) throw new TypeError("Grid cells must contain at least one pixel.");
  const tiles: RawRgbImage[] = [];
  for (let row = 0; row < gridSize; row += 1) {
    for (let column = 0; column < gridSize; column += 1) {
      const data = Buffer.allocUnsafe(tileWidth * tileHeight * 3);
      for (let y = 0; y < tileHeight; y += 1) {
        const sourceStart = ((row * tileHeight + y) * source.width + column * tileWidth) * 3;
        const destinationStart = y * tileWidth * 3;
        data.set(
          source.data.subarray(sourceStart, sourceStart + tileWidth * 3),
          destinationStart,
        );
      }
      tiles.push({ data, width: tileWidth, height: tileHeight });
    }
  }
  return tiles;
}

export class ClassificationModel {
  readonly #session: SessionLike;
  readonly #asset: ModelAsset;

  private constructor(session: SessionLike, asset: ModelAsset) {
    this.#session = session;
    this.#asset = asset;
    if (!session.inputNames.includes(asset.inputName)) {
      throw new Error(`Classification model has no input named ${asset.inputName}.`);
    }
    if (!session.outputNames.includes(asset.outputName)) {
      throw new Error(`Classification model has no output named ${asset.outputName}.`);
    }
  }

  static async create(modelPath: string): Promise<ClassificationModel> {
    const manifest = await loadModelManifest();
    const asset = manifest.models.find((model) => model.id === "classification");
    if (!asset) throw new Error("Classification model is missing from the manifest.");
    const session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
      logSeverityLevel: 3,
    });
    return new ClassificationModel(session, asset);
  }

  static fromSessionForTests(session: SessionLike, asset: ModelAsset): ClassificationModel {
    return new ClassificationModel(session, asset);
  }

  async probabilities(images: ClassificationImage[]): Promise<Float32Array[]> {
    const input = await classificationTensor(images);
    const outputs = await this.#session.run({ [this.#asset.inputName]: input });
    const output = outputs[this.#asset.outputName];
    if (!output) throw new Error(`Classification output is missing: ${this.#asset.outputName}.`);
    if (
      output.dims.length !== 2 ||
      output.dims[0] !== images.length ||
      output.dims[1] !== CLASS_NAMES.length
    ) {
      throw new Error(`Unexpected classification output shape: ${output.dims.join("x")}.`);
    }
    const values = Float32Array.from(output.data as ArrayLike<number>);
    return images.map((_, index) =>
      values.slice(index * CLASS_NAMES.length, (index + 1) * CLASS_NAMES.length),
    );
  }

  async classify(image: ClassificationImage): Promise<ClassificationResult> {
    const [probabilities] = await this.probabilities([image]);
    if (!probabilities) throw new Error("Classification model returned no probabilities.");
    let classId = 0;
    for (let index = 1; index < probabilities.length; index += 1) {
      if ((probabilities[index] ?? Number.NEGATIVE_INFINITY) > (probabilities[classId] ?? 0)) {
        classId = index;
      }
    }
    return {
      classId,
      className: CLASS_NAMES[classId] ?? "unknown",
      confidence: probabilities[classId] ?? 0,
      probabilities,
    };
  }

  async targetConfidences(images: ClassificationImage[], targetClass: number): Promise<number[]> {
    if (!Number.isInteger(targetClass) || targetClass < 0 || targetClass >= CLASS_NAMES.length) {
      throw new TypeError(`targetClass must be between 0 and ${String(CLASS_NAMES.length - 1)}.`);
    }
    return (await this.probabilities(images)).map((values) => values[targetClass] ?? 0);
  }

  async classifyGrid(
    image: ClassificationImage,
    gridSize: number,
    targetClass: number,
  ): Promise<Array<{ cell: number; confidence: number }>> {
    const tiles = splitRgbGrid(await decodeRgbImage(image), gridSize);
    const confidences = await this.targetConfidences(tiles, targetClass);
    return confidences.map((confidence, index) => ({ cell: index + 1, confidence }));
  }
}
