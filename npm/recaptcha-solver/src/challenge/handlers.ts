// SPDX-License-Identifier: AGPL-3.0-only

import type { ClassificationImage } from "../inference/classification.js";
import { classificationTargetClass } from "../inference/classification-targets.js";
import { detectionTargetClass } from "../inference/detection-targets.js";
import { compositeRgbGridImage, downloadChallengeImage } from "./image-io.js";
import { LowConfidenceError, UnsupportedChallengeError } from "./errors.js";

export type ImageChallengeType = "selection_3x3" | "dynamic_3x3" | "square_4x4";

export interface HandlerNavigation {
  imageUrls(timeoutMs?: number): Promise<string[]>;
  clickTile(cell: number, timeoutMs?: number): Promise<boolean>;
}

export interface ClassificationInference {
  classifyGrid(
    image: ClassificationImage,
    gridSize: number,
    targetClass: number,
  ): Promise<Array<{ cell: number; confidence: number }>>;
}

export interface DetectionInference {
  detectGridCells(
    image: ClassificationImage,
    targetClass: number,
    gridSize?: number,
    options?: { confidenceThreshold?: number; nmsThreshold?: number },
  ): Promise<number[]>;
}

export interface HandlerClock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export interface CaptchaHandlerOptions {
  defaultTimeoutMs?: number;
  minConfidence?: number;
  fourthCellConfidence?: number;
  repeatedCellConfidence?: number;
  detectionConfidence?: number;
  maxDynamicRounds?: number;
  clock?: HandlerClock;
  downloadImage?: typeof downloadChallengeImage;
  compositeImage?: typeof compositeRgbGridImage;
}

const systemClock: HandlerClock = {
  now: Date.now,
  async sleep(milliseconds): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  },
};

function confidence(value: number, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1) {
    throw new TypeError(`${name} must be between 0 and 1.`);
  }
  return resolved;
}

function positiveInteger(value: number, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return resolved;
}

export class CaptchaHandlers {
  readonly #navigation: HandlerNavigation;
  readonly #classification: ClassificationInference;
  readonly #detection: DetectionInference;
  readonly #clock: HandlerClock;
  readonly #downloadImage: typeof downloadChallengeImage;
  readonly #compositeImage: typeof compositeRgbGridImage;
  readonly #defaultTimeoutMs: number;
  readonly #minConfidence: number;
  readonly #fourthCellConfidence: number;
  readonly #repeatedCellConfidence: number;
  readonly #detectionConfidence: number;
  readonly #maxDynamicRounds: number;

  constructor(
    navigation: HandlerNavigation,
    classification: ClassificationInference,
    detection: DetectionInference,
    options: CaptchaHandlerOptions = {},
  ) {
    this.#navigation = navigation;
    this.#classification = classification;
    this.#detection = detection;
    this.#clock = options.clock ?? systemClock;
    this.#downloadImage = options.downloadImage ?? downloadChallengeImage;
    this.#compositeImage = options.compositeImage ?? compositeRgbGridImage;
    this.#defaultTimeoutMs = positiveInteger(options.defaultTimeoutMs ?? 10_000, 10_000, "defaultTimeoutMs");
    this.#minConfidence = confidence(options.minConfidence ?? 0.2, 0.2, "minConfidence");
    this.#fourthCellConfidence = confidence(
      options.fourthCellConfidence ?? 0.7,
      0.7,
      "fourthCellConfidence",
    );
    this.#repeatedCellConfidence = confidence(
      options.repeatedCellConfidence ?? 0.7,
      0.7,
      "repeatedCellConfidence",
    );
    this.#detectionConfidence = confidence(
      options.detectionConfidence ?? 0.6,
      0.6,
      "detectionConfidence",
    );
    this.#maxDynamicRounds = positiveInteger(
      options.maxDynamicRounds ?? 20,
      20,
      "maxDynamicRounds",
    );
  }

  async solve(type: ImageChallengeType, keyword: string): Promise<number[]> {
    if (type === "square_4x4") return this.#solveSquare(keyword);
    const targetClass = classificationTargetClass(keyword);
    if (targetClass === undefined) return [];
    if (type === "selection_3x3") return this.#solveSelection(targetClass);
    if (type === "dynamic_3x3") return this.#solveDynamic(targetClass);
    throw new UnsupportedChallengeError(`Unsupported image challenge: ${String(type)}`);
  }

  async #clickCells(cells: readonly number[]): Promise<number[]> {
    const clicked: number[] = [];
    for (const cell of cells) {
      if (await this.#navigation.clickTile(cell, this.#defaultTimeoutMs)) {
        clicked.push(cell);
        await this.#clock.sleep(300);
      }
    }
    return clicked;
  }

  #rankInitial(results: Array<{ cell: number; confidence: number }>): number[] {
    const ranked = [...results].sort((left, right) => right.confidence - left.confidence);
    if (ranked.length < 3) return [];
    for (const result of ranked.slice(0, 3)) {
      if (result.confidence < this.#minConfidence) {
        throw new LowConfidenceError(
          `Top cell confidence ${result.confidence.toFixed(3)} is below ${this.#minConfidence.toFixed(3)}.`,
        );
      }
    }
    const answers = ranked.slice(0, 3).map(({ cell }) => cell);
    const fourth = ranked[3];
    if (fourth && fourth.confidence >= this.#fourthCellConfidence) answers.push(fourth.cell);
    return answers;
  }

  async #mainImage(): Promise<{ image: Buffer; urls: string[] } | undefined> {
    const urls = await this.#navigation.imageUrls(this.#defaultTimeoutMs);
    const first = [...new Set(urls)][0];
    if (!first) return undefined;
    return { image: await this.#downloadImage(first), urls };
  }

  async #solveSelection(targetClass: number): Promise<number[]> {
    const source = await this.#mainImage();
    if (!source) return [];
    const answers = this.#rankInitial(
      await this.#classification.classifyGrid(source.image, 3, targetClass),
    );
    return this.#clickCells(answers);
  }

  async #solveDynamic(targetClass: number): Promise<number[]> {
    const source = await this.#mainImage();
    if (!source) return [];
    let image: ClassificationImage = source.image;
    let previousUrls = source.urls;
    let answers = this.#rankInitial(await this.#classification.classifyGrid(image, 3, targetClass));
    const allClicked = await this.#clickCells(answers);
    answers = [...allClicked];

    for (let round = 0; round < this.#maxDynamicRounds && answers.length > 0; round += 1) {
      const currentUrls = await this.#waitForChangedImages(answers, previousUrls);
      if (!currentUrls) break;
      for (const cell of answers) {
        const url = currentUrls[cell - 1];
        if (!url) continue;
        image = await this.#compositeImage(image, await this.#downloadImage(url), cell, 3);
      }
      const refreshed = await this.#classification.classifyGrid(image, 3, targetClass);
      const answerSet = new Set(answers);
      const next = refreshed
        .filter(({ cell, confidence: score }) => answerSet.has(cell) && score >= this.#repeatedCellConfidence)
        .map(({ cell }) => cell);
      answers = await this.#clickCells(next);
      allClicked.push(...answers);
      previousUrls = currentUrls;
    }
    return allClicked;
  }

  async #waitForChangedImages(
    clickedCells: readonly number[],
    previousUrls: readonly string[],
  ): Promise<string[] | undefined> {
    const deadline = this.#clock.now() + Math.floor(this.#defaultTimeoutMs / 3);
    while (this.#clock.now() < deadline) {
      await this.#clock.sleep(300);
      const current = await this.#navigation.imageUrls(Math.min(1_000, this.#defaultTimeoutMs));
      if (
        current.length === previousUrls.length &&
        clickedCells.every((cell) => Boolean(current[cell - 1]) && current[cell - 1] !== previousUrls[cell - 1])
      ) {
        return current;
      }
    }
    return undefined;
  }

  async #solveSquare(keyword: string): Promise<number[]> {
    const targetClass = detectionTargetClass(keyword);
    if (targetClass === undefined) return [];
    const source = await this.#mainImage();
    if (!source) return [];
    const cells = await this.#detection.detectGridCells(source.image, targetClass, 450, {
      confidenceThreshold: this.#detectionConfidence,
    });
    const valid = [...new Set(cells)].filter((cell) => cell >= 1 && cell <= 16).sort((a, b) => a - b);
    const clicked = new Set(await this.#clickCells([...valid].reverse()));
    return valid.filter((cell) => clicked.has(cell));
  }
}
