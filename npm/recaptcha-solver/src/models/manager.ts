// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadModelManifest } from "./manifest.js";
import type { ModelAsset, ModelManifest, ResolvedModels } from "./types.js";

const DEFAULT_ALLOWED_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 15 * 60_000;
const STALE_LOCK_MS = 20 * 60_000;
const MAX_REDIRECTS = 5;
const MAX_DOWNLOAD_ATTEMPTS = 3;

export interface EnsureModelsOptions {
  manifest?: ModelManifest;
  cacheDirectory?: string;
  fetchImplementation?: typeof fetch;
  allowedHosts?: ReadonlySet<string>;
  allowInsecureForTests?: boolean;
  downloadTimeoutMs?: number;
  lockTimeoutMs?: number;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function defaultCacheRoot(): string {
  if (process.env.RECAPTCHA_SOLVER_CACHE_DIR) {
    return process.env.RECAPTCHA_SOLVER_CACHE_DIR;
  }
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "conghuy113-recaptcha-solver");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", "conghuy113-recaptcha-solver");
  }
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "conghuy113-recaptcha-solver");
}

function modelDirectory(manifest: ModelManifest, override?: string): string {
  if (override) return override;
  if (process.env.RECAPTCHA_SOLVER_MODEL_DIR) return process.env.RECAPTCHA_SOLVER_MODEL_DIR;
  return join(defaultCacheRoot(), "models", manifest.modelSetVersion);
}

async function hashAndSize(path: string): Promise<{ sha256: string; size: number }> {
  const digest = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    digest.update(buffer);
    size += buffer.byteLength;
  }
  return { sha256: digest.digest("hex"), size };
}

async function isVerified(path: string, asset: ModelAsset): Promise<boolean> {
  try {
    const information = await stat(path);
    if (!information.isFile() || information.size !== asset.size) return false;
    const result = await hashAndSize(path);
    return result.size === asset.size && result.sha256 === asset.sha256;
  } catch (error) {
    if (errno(error) === "ENOENT") return false;
    throw error;
  }
}

function validateDownloadUrl(
  url: URL,
  allowedHosts: ReadonlySet<string>,
  allowInsecureForTests: boolean,
): void {
  const protocolAllowed = url.protocol === "https:" || (allowInsecureForTests && url.protocol === "http:");
  if (!protocolAllowed) throw new Error(`Refusing non-HTTPS model URL: ${url.href}`);
  if (!allowedHosts.has(url.hostname)) {
    throw new Error(`Refusing model download from untrusted host: ${url.hostname}`);
  }
  if (url.username || url.password) throw new Error("Model URLs must not contain credentials.");
}

async function fetchWithValidatedRedirects(
  initialUrl: string,
  signal: AbortSignal,
  options: Required<Pick<EnsureModelsOptions, "fetchImplementation" | "allowedHosts" | "allowInsecureForTests">>,
): Promise<Response> {
  let current = new URL(initialUrl);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    validateDownloadUrl(current, options.allowedHosts, options.allowInsecureForTests);
    const response = await options.fetchImplementation(current, { redirect: "manual", signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error(`Model redirect has no Location header: ${current.href}`);
    current = new URL(location, current);
  }
  throw new Error(`Model download exceeded ${String(MAX_REDIRECTS)} redirects.`);
}

async function writeResponse(
  response: Response,
  temporaryPath: string,
  asset: ModelAsset,
): Promise<void> {
  if (!response.ok) throw new Error(`Model download returned HTTP ${String(response.status)}.`);
  if (!response.body) throw new Error("Model download returned an empty response body.");
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) !== asset.size) {
    throw new Error(`Model Content-Length is ${contentLength}; expected ${String(asset.size)}.`);
  }

  const file = await open(temporaryPath, "wx");
  const digest = createHash("sha256");
  let size = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      size += chunk.byteLength;
      if (size > asset.size) throw new Error(`Model download exceeded ${String(asset.size)} bytes.`);
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
        if (bytesWritten < 1) throw new Error("Could not make progress writing model file.");
        offset += bytesWritten;
      }
    }
    await file.sync();
  } finally {
    await file.close();
  }

  if (size !== asset.size) {
    throw new Error(`Downloaded model has ${String(size)} bytes; expected ${String(asset.size)}.`);
  }
  const actualHash = digest.digest("hex");
  if (actualHash !== asset.sha256) {
    throw new Error(`Downloaded model SHA-256 is ${actualHash}; expected ${asset.sha256}.`);
  }
}

async function downloadAsset(asset: ModelAsset, destination: string, options: EnsureModelsOptions): Promise<void> {
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  if (!fetchImplementation) throw new Error("This Node.js runtime does not provide fetch().");
  const timeoutMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt += 1) {
    const temporaryPath = `${destination}.${String(process.pid)}.${String(Date.now())}.${String(attempt)}.tmp`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchWithValidatedRedirects(asset.url, controller.signal, {
        fetchImplementation,
        allowedHosts: options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS,
        allowInsecureForTests: options.allowInsecureForTests ?? false,
      });
      await writeResponse(response, temporaryPath, asset);
      await rename(temporaryPath, destination);
      return;
    } catch (error) {
      lastError = error;
      await rm(temporaryPath, { force: true });
      if (attempt < MAX_DOWNLOAD_ATTEMPTS) await delay(attempt * 250);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Could not download verified model ${asset.id}.`, { cause: lastError });
}

async function acquireLock(lockPath: string, timeoutMs: number): Promise<() => Promise<void>> {
  const started = Date.now();
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      await handle.close();
      return async () => rm(lockPath, { force: true });
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
      try {
        const information = await stat(lockPath);
        if (Date.now() - information.mtimeMs > STALE_LOCK_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (errno(statError) === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`Timed out waiting for model cache lock: ${lockPath}`);
      }
      await delay(200);
    }
  }
}

async function ensureModelsInternal(options: EnsureModelsOptions): Promise<ResolvedModels> {
  const manifest = options.manifest ?? (await loadModelManifest());
  const directory = modelDirectory(manifest, options.cacheDirectory);
  await mkdir(directory, { recursive: true });
  const releaseLock = await acquireLock(
    join(directory, ".model-download.lock"),
    options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
  );
  try {
    for (const asset of manifest.models) {
      const destination = join(directory, asset.fileName);
      if (await isVerified(destination, asset)) continue;
      await rm(destination, { force: true });
      await downloadAsset(asset, destination, options);
      if (!(await isVerified(destination, asset))) {
        await rm(destination, { force: true });
        throw new Error(`Model verification failed after download: ${asset.id}`);
      }
    }
  } finally {
    await releaseLock();
  }

  const classification = manifest.models.find((model) => model.id === "classification");
  const detection = manifest.models.find((model) => model.id === "detection");
  if (!classification || !detection) throw new Error("Validated model manifest is incomplete.");
  return {
    directory,
    classification: join(directory, classification.fileName),
    detection: join(directory, detection.fileName),
    manifest,
  };
}

let defaultEnsurePromise: Promise<ResolvedModels> | undefined;

export function ensureModels(options?: EnsureModelsOptions): Promise<ResolvedModels> {
  if (options) return ensureModelsInternal(options);
  defaultEnsurePromise ??= ensureModelsInternal({}).catch((error: unknown) => {
    defaultEnsurePromise = undefined;
    throw error;
  });
  return defaultEnsurePromise;
}
