// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from "node:fs/promises";

import bundledManifest from "../../model-manifest.json" with { type: "json" };

import type {
  ModelAsset,
  ModelId,
  ModelManifest,
  ModelTask,
  ShapeDimension,
} from "./types.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const FILE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.onnx$/u;

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function requireShape(value: unknown, name: string): ShapeDimension[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty array.`);
  }
  return value.map((dimension, index) => {
    if (
      (typeof dimension === "number" && Number.isInteger(dimension) && dimension > 0) ||
      (typeof dimension === "string" && dimension.length > 0)
    ) {
      return dimension;
    }
    throw new TypeError(`${name}[${String(index)}] is invalid.`);
  });
}

function parseAsset(value: unknown, index: number): ModelAsset {
  const raw = requireObject(value, `models[${String(index)}]`);
  const id = requireString(raw.id, `models[${String(index)}].id`) as ModelId;
  const task = requireString(raw.task, `models[${String(index)}].task`) as ModelTask;
  if (!(["classification", "detection"] as const).includes(id)) {
    throw new TypeError(`Unsupported model id: ${id}.`);
  }
  if (!(["classify", "detect"] as const).includes(task)) {
    throw new TypeError(`Unsupported model task: ${task}.`);
  }

  const fileName = requireString(raw.fileName, `models[${String(index)}].fileName`);
  if (!FILE_NAME_PATTERN.test(fileName) || fileName.includes("..")) {
    throw new TypeError(`Unsafe model file name: ${fileName}.`);
  }
  const url = requireString(raw.url, `models[${String(index)}].url`);
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:") {
    throw new TypeError(`Model URL must use HTTPS: ${url}.`);
  }

  const size = raw.size;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1) {
    throw new TypeError(`models[${String(index)}].size must be a positive integer.`);
  }
  const sha256 = requireString(raw.sha256, `models[${String(index)}].sha256`).toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) {
    throw new TypeError(`models[${String(index)}].sha256 must be a SHA-256 digest.`);
  }

  return {
    id,
    fileName,
    url,
    size,
    sha256,
    task,
    inputName: requireString(raw.inputName, `models[${String(index)}].inputName`),
    outputName: requireString(raw.outputName, `models[${String(index)}].outputName`),
    inputShape: requireShape(raw.inputShape, `models[${String(index)}].inputShape`),
    outputShape: requireShape(raw.outputShape, `models[${String(index)}].outputShape`),
  };
}

export function validateModelManifest(value: unknown): ModelManifest {
  const raw = requireObject(value, "model manifest");
  if (raw.schemaVersion !== 1) throw new TypeError("Unsupported model manifest schema.");
  if (raw.license !== "AGPL-3.0-only") {
    throw new TypeError("Model manifest license must be AGPL-3.0-only.");
  }
  const modelSetVersion = requireString(raw.modelSetVersion, "modelSetVersion");
  if (!VERSION_PATTERN.test(modelSetVersion)) {
    throw new TypeError("modelSetVersion must use semantic versioning.");
  }
  const releaseTag = requireString(raw.releaseTag, "releaseTag");
  if (releaseTag !== `models-v${modelSetVersion}`) {
    throw new TypeError("releaseTag must match modelSetVersion.");
  }
  if (!Array.isArray(raw.models) || raw.models.length !== 2) {
    throw new TypeError("Model manifest must contain exactly two models.");
  }
  const models = raw.models.map(parseAsset) as [ModelAsset, ModelAsset];
  if (new Set(models.map((model) => model.id)).size !== 2) {
    throw new TypeError("Model manifest must contain one classification and one detection model.");
  }
  if (new Set(models.map((model) => model.fileName)).size !== 2) {
    throw new TypeError("Model file names must be unique.");
  }
  const classification = models.find((model) => model.id === "classification");
  const detection = models.find((model) => model.id === "detection");
  if (classification?.task !== "classify" || detection?.task !== "detect") {
    throw new TypeError("Model ids and tasks do not match.");
  }
  return {
    schemaVersion: 1,
    modelSetVersion,
    releaseTag,
    license: "AGPL-3.0-only",
    models,
  };
}

export async function loadModelManifest(path?: string): Promise<ModelManifest> {
  if (path === undefined) return validateModelManifest(bundledManifest);

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Could not read model manifest: ${path}`, { cause: error });
  }
  return validateModelManifest(parsed);
}
