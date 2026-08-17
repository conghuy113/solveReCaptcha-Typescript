// SPDX-License-Identifier: AGPL-3.0-only

import sharp from "sharp";

import { decodeRgbImage } from "../inference/classification.js";
import type { ClassificationImage, RawRgbImage } from "../inference/classification.js";
import { ChallengeImageDownloadError } from "./errors.js";

const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const TRUSTED_IMAGE_DOMAINS = ["google.com", "recaptcha.net"] as const;

export interface ChallengeImageDownloadOptions {
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer.`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
}

function trustedImageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ChallengeImageDownloadError(`Challenge image URL is invalid: ${value}`, {
      cause: error,
    });
  }
  const hostname = url.hostname.toLowerCase();
  const trusted = TRUSTED_IMAGE_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
  if (url.protocol !== "https:" || !trusted || !url.pathname.includes("/recaptcha/")) {
    throw new ChallengeImageDownloadError(
      "Challenge images must use HTTPS on a trusted reCAPTCHA endpoint.",
    );
  }
  return url;
}

async function responseBuffer(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new ChallengeImageDownloadError(
      `Challenge image exceeds the ${String(maxBytes)} byte limit.`,
    );
  }
  const contentType = response.headers.get("content-type");
  if (contentType && !contentType.toLowerCase().startsWith("image/")) {
    throw new ChallengeImageDownloadError(`Unexpected challenge image content type: ${contentType}`);
  }
  if (!response.body) throw new ChallengeImageDownloadError("Challenge image response has no body.");

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ChallengeImageDownloadError(
          `Challenge image exceeds the ${String(maxBytes)} byte limit.`,
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new ChallengeImageDownloadError("Challenge image response is empty.");
  return Buffer.concat(chunks, total);
}

export async function downloadChallengeImage(
  value: string,
  options: ChallengeImageDownloadOptions = {},
): Promise<Buffer> {
  const url = trustedImageUrl(value);
  const retries = nonNegativeInteger(options.retries ?? 3, "retries");
  const retryDelayMs = nonNegativeInteger(options.retryDelayMs ?? 200, "retryDelayMs");
  const timeoutMs = positiveInteger(options.timeoutMs ?? 5_000, "timeoutMs");
  const maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES, "maxBytes");
  const fetchImage = options.fetch ?? fetch;
  const sleep = options.sleep ?? (async (milliseconds: number) => {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  });
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImage(url, {
        headers: { accept: "image/*" },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ChallengeImageDownloadError(
          `Challenge image request failed with HTTP ${String(response.status)}.`,
        );
      }
      return await responseBuffer(response, maxBytes);
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      const backoff = Math.min(5_000, Math.max(500, retryDelayMs * 2 ** attempt));
      await sleep(backoff);
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new ChallengeImageDownloadError(
    `Failed to download challenge image after ${String(retries + 1)} attempts: ${message}`,
    { cause: lastError },
  );
}

export async function compositeRgbGridImage(
  mainImage: ClassificationImage,
  newImage: ClassificationImage,
  cell: number,
  gridColumns = 3,
): Promise<RawRgbImage> {
  if (!Number.isInteger(gridColumns) || gridColumns < 1) {
    throw new TypeError("gridColumns must be a positive integer.");
  }
  if (!Number.isInteger(cell) || cell < 1 || cell > gridColumns ** 2) {
    throw new TypeError(`cell must be between 1 and ${String(gridColumns ** 2)}.`);
  }
  const main = await decodeRgbImage(mainImage);
  const incoming = await decodeRgbImage(newImage);
  const cellWidth = Math.floor(main.width / gridColumns);
  const cellHeight = Math.floor(main.height / gridColumns);
  if (cellWidth < 1 || cellHeight < 1) {
    throw new TypeError("Grid cells must contain at least one pixel.");
  }
  const resized = await sharp(Buffer.from(incoming.data), {
    raw: { width: incoming.width, height: incoming.height, channels: 3 },
  })
    .resize(cellWidth, cellHeight, { fit: "fill", kernel: sharp.kernel.linear })
    .raw()
    .toBuffer();

  const data = Buffer.from(main.data);
  const index = cell - 1;
  const row = Math.floor(index / gridColumns);
  const column = index % gridColumns;
  for (let y = 0; y < cellHeight; y += 1) {
    const sourceStart = y * cellWidth * 3;
    const destinationStart = ((row * cellHeight + y) * main.width + column * cellWidth) * 3;
    data.set(resized.subarray(sourceStart, sourceStart + cellWidth * 3), destinationStart);
  }
  return { data, width: main.width, height: main.height };
}
