// SPDX-License-Identifier: AGPL-3.0-only

export type ModelId = "classification" | "detection";
export type ModelTask = "classify" | "detect";
export type ShapeDimension = number | string;

export interface ModelAsset {
  id: ModelId;
  fileName: string;
  url: string;
  size: number;
  sha256: string;
  task: ModelTask;
  inputName: string;
  outputName: string;
  inputShape: ShapeDimension[];
  outputShape: ShapeDimension[];
}

export interface ModelManifest {
  schemaVersion: 1;
  modelSetVersion: string;
  releaseTag: string;
  license: "AGPL-3.0-only";
  models: [ModelAsset, ModelAsset];
}

export interface ResolvedModels {
  directory: string;
  classification: string;
  detection: string;
  manifest: ModelManifest;
}
