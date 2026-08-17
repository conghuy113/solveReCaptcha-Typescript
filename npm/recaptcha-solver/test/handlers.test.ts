// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import { LowConfidenceError } from "../src/challenge/errors.js";
import { CaptchaHandlers } from "../src/challenge/handlers.js";
import type {
  ClassificationInference,
  DetectionInference,
  HandlerClock,
  HandlerNavigation,
} from "../src/challenge/handlers.js";
import { classificationTargetClass } from "../src/inference/classification-targets.js";

class FakeClock implements HandlerClock {
  current = 0;
  async sleep(milliseconds: number): Promise<void> { this.current += milliseconds; }
  now(): number { return this.current; }
}

class FakeNavigation implements HandlerNavigation {
  readonly clicks: number[] = [];
  readonly urlResponses: string[][];

  constructor(...urlResponses: string[][]) {
    this.urlResponses = urlResponses;
  }

  async imageUrls(): Promise<string[]> {
    return this.urlResponses.length > 1
      ? this.urlResponses.shift() ?? []
      : this.urlResponses[0] ?? [];
  }

  async clickTile(cell: number): Promise<boolean> {
    this.clicks.push(cell);
    return true;
  }
}

class FakeClassification implements ClassificationInference {
  readonly responses: Array<Array<{ cell: number; confidence: number }>>;

  constructor(...responses: Array<Array<{ cell: number; confidence: number }>>) {
    this.responses = responses;
  }

  async classifyGrid(): Promise<Array<{ cell: number; confidence: number }>> {
    return this.responses.shift() ?? [];
  }
}

class FakeDetection implements DetectionInference {
  constructor(readonly cells: number[] = []) {}
  async detectGridCells(): Promise<number[]> { return this.cells; }
}

function ranking(...confidences: number[]): Array<{ cell: number; confidence: number }> {
  return confidences.map((confidence, index) => ({ cell: index + 1, confidence }));
}

function handlers(
  navigation: FakeNavigation,
  classification: FakeClassification,
  detection = new FakeDetection(),
  clock = new FakeClock(),
): CaptchaHandlers {
  return new CaptchaHandlers(navigation, classification, detection, {
    defaultTimeoutMs: 900,
    maxDynamicRounds: 2,
    clock,
    downloadImage: async (url) => Buffer.from(url),
    compositeImage: async (main) => Buffer.isBuffer(main)
      ? { data: Buffer.alloc(27), width: 3, height: 3 }
      : main,
  });
}

test("maps supported multilingual classification targets", () => {
  assert.equal(classificationTargetClass("Buses"), 2);
  assert.equal(classificationTargetClass("пешеходные переходы"), 5);
  assert.equal(classificationTargetClass("Select all images with traffic lights"), 13);
  assert.equal(classificationTargetClass("boats"), undefined);
});

test("selection handler ranks three cells and includes a confident fourth", async () => {
  const navigation = new FakeNavigation(["https://www.google.com/recaptcha/api2/payload?id=grid"]);
  const classification = new FakeClassification(ranking(0.3, 0.95, 0.7, 0.8, 0.1));
  assert.deepEqual(await handlers(navigation, classification).solve("selection_3x3", "buses"), [2, 4, 3]);
  assert.deepEqual(navigation.clicks, [2, 4, 3]);
});

test("selection handler requests a reload signal on low top-three confidence", async () => {
  const navigation = new FakeNavigation(["https://www.google.com/recaptcha/api2/payload?id=grid"]);
  const classification = new FakeClassification(ranking(0.9, 0.8, 0.1, 0.05));
  await assert.rejects(
    handlers(navigation, classification).solve("selection_3x3", "cars"),
    LowConfidenceError,
  );
  assert.deepEqual(navigation.clicks, []);
});

test("dynamic handler composites changed cells and stops when replacements no longer match", async () => {
  const previous = Array.from({ length: 9 }, (_, index) => `old-${String(index + 1)}`);
  const changed = previous.map((url, index) => index < 3 ? `new-${String(index + 1)}` : url);
  const navigation = new FakeNavigation(previous, changed);
  const classification = new FakeClassification(
    ranking(0.95, 0.9, 0.85, 0.1, 0.09, 0.08, 0.07, 0.06, 0.05),
    ranking(0.1, 0.2, 0.3, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4),
  );
  assert.deepEqual(await handlers(navigation, classification).solve("dynamic_3x3", "cars"), [1, 2, 3]);
  assert.deepEqual(navigation.clicks, [1, 2, 3]);
});

test("square handler maps the detection target and clicks cells in reverse visual order", async () => {
  const navigation = new FakeNavigation(["https://www.google.com/recaptcha/api2/payload?id=square"]);
  const solver = handlers(navigation, new FakeClassification(), new FakeDetection([2, 16, 19, 2]));
  assert.deepEqual(await solver.solve("square_4x4", "traffic lights"), [2, 16]);
  assert.deepEqual(navigation.clicks, [16, 2]);
});
