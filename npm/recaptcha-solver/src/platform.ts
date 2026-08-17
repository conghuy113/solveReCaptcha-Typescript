import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

interface PlatformPackage {
  packageName: string;
  executableName: string;
}

interface BuildInfo {
  schemaVersion: number;
  protocolVersion: number;
  package: string;
  platform: string;
  executable: string;
}

const NATIVE_FORMAT_VERSION = 1;
export const WORKER_PROTOCOL_VERSION = 1;

const PLATFORM_PACKAGES: Readonly<Record<string, PlatformPackage>> = {
  "win32-x64": {
    packageName: "@conghuy113/recaptcha-solver-win32-x64",
    executableName: "recaptcha-solver-worker.exe",
  },
  "linux-x64": {
    packageName: "@conghuy113/recaptcha-solver-linux-x64",
    executableName: "recaptcha-solver-worker",
  },
  "darwin-x64": {
    packageName: "@conghuy113/recaptcha-solver-darwin-x64",
    executableName: "recaptcha-solver-worker",
  },
  "darwin-arm64": {
    packageName: "@conghuy113/recaptcha-solver-darwin-arm64",
    executableName: "recaptcha-solver-worker",
  },
};

const require = createRequire(import.meta.url);

function readJsonObject(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read native package metadata: ${path}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Native package metadata must be a JSON object: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

function parseBuildInfo(path: string): BuildInfo {
  const value = readJsonObject(path);
  const requiredStrings = ["package", "platform", "executable"] as const;
  for (const field of requiredStrings) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new Error(`Invalid native build metadata field '${field}' in ${path}.`);
    }
  }
  if (typeof value.schemaVersion !== "number" || typeof value.protocolVersion !== "number") {
    throw new Error(`Invalid native build version metadata in ${path}.`);
  }
  return value as unknown as BuildInfo;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function materializeWindowsWorker(
  packageRoot: string,
  sourceExecutable: string,
  platformPackage: PlatformPackage,
): string {
  const checksumPath = join(packageRoot, "checksums.json");
  const checksums = readJsonObject(checksumPath);
  const checksumKey = join(
    "bin",
    "recaptcha-solver-worker",
    platformPackage.executableName,
  ).replaceAll(sep, "/");
  const executableChecksum = checksums[checksumKey];
  if (typeof executableChecksum !== "string") {
    throw new Error(`Native worker checksum is missing: ${checksumKey}`);
  }

  const cacheBase = process.env.LOCALAPPDATA || tmpdir();
  const destination = join(
    cacheBase,
    "conghuy113-recaptcha-solver",
    `worker-${executableChecksum.slice(0, 20)}`,
  );
  const cachedExecutable = join(destination, platformPackage.executableName);
  if (existsSync(cachedExecutable) && sha256(cachedExecutable) === executableChecksum) {
    return cachedExecutable;
  }
  if (existsSync(destination)) {
    rmSync(destination, { recursive: true, force: true });
  }

  mkdirSync(dirname(destination), { recursive: true });
  const temporaryDestination = `${destination}.${String(process.pid)}.${String(Date.now())}.tmp`;
  rmSync(temporaryDestination, { recursive: true, force: true });
  try {
    cpSync(dirname(sourceExecutable), temporaryDestination, { recursive: true });
    const temporaryExecutable = join(temporaryDestination, platformPackage.executableName);
    if (sha256(temporaryExecutable) !== executableChecksum) {
      throw new Error("Cached native worker checksum verification failed after copying.");
    }
    if (existsSync(cachedExecutable) && sha256(cachedExecutable) === executableChecksum) {
      return cachedExecutable;
    }
    renameSync(temporaryDestination, destination);
  } finally {
    rmSync(temporaryDestination, { recursive: true, force: true });
  }
  return cachedExecutable;
}

export function validateNativePackage(
  packageRoot: string,
  platformKey: string,
  platformPackage: PlatformPackage,
): string {
  const buildInfoPath = join(packageRoot, "build-info.json");
  const buildInfo = parseBuildInfo(buildInfoPath);
  if (buildInfo.schemaVersion !== NATIVE_FORMAT_VERSION) {
    throw new Error(
      `Unsupported native package format ${String(buildInfo.schemaVersion)} in ${buildInfoPath}.`,
    );
  }
  if (buildInfo.protocolVersion !== WORKER_PROTOCOL_VERSION) {
    throw new Error(
      `Native worker protocol ${String(buildInfo.protocolVersion)} does not match SDK protocol ` +
        `${String(WORKER_PROTOCOL_VERSION)}. Reinstall matching package versions.`,
    );
  }
  if (buildInfo.package !== platformPackage.packageName || buildInfo.platform !== platformKey) {
    throw new Error(`Native package metadata does not match ${platformPackage.packageName}.`);
  }

  const expectedRelativeExecutable = join(
    "bin",
    "recaptcha-solver-worker",
    platformPackage.executableName,
  );
  const executablePath = join(packageRoot, expectedRelativeExecutable);
  const relativeExecutable = relative(packageRoot, executablePath);
  if (relativeExecutable.startsWith(`..${sep}`) || relativeExecutable === "..") {
    throw new Error(`Native worker executable escapes its package directory: ${executablePath}`);
  }
  if (buildInfo.executable.replaceAll("/", sep) !== expectedRelativeExecutable) {
    throw new Error(`Native package declares an unexpected executable: ${buildInfo.executable}.`);
  }
  try {
    if (!statSync(executablePath).isFile()) throw new Error("not a file");
    if (process.platform !== "win32") accessSync(executablePath, constants.X_OK);
  } catch (error) {
    throw new Error(`Native worker is missing or not executable: ${executablePath}`, {
      cause: error,
    });
  }

  const checksumPath = join(packageRoot, "checksums.json");
  const checksums = readJsonObject(checksumPath);
  const checksumKey = expectedRelativeExecutable.replaceAll(sep, "/");
  const expectedChecksum = checksums[checksumKey];
  if (typeof expectedChecksum !== "string" || sha256(executablePath) !== expectedChecksum) {
    throw new Error(`Native worker checksum verification failed: ${executablePath}`);
  }
  return executablePath;
}

export function resolveWorkerBinary(): string {
  // Intended for repository development and automated tests. Published usage
  // resolves only a bundled platform package and never invokes Python.
  const explicitBinary = process.env.RECAPTCHA_SOLVER_BINARY;
  if (explicitBinary) return explicitBinary;

  const platformKey = `${process.platform}-${process.arch}`;
  const platformPackage = PLATFORM_PACKAGES[platformKey];
  if (!platformPackage) {
    throw new Error(
      `Unsupported platform: ${platformKey}. Supported platforms are: ${Object.keys(PLATFORM_PACKAGES).join(", ")}.`,
    );
  }

  try {
    const manifestPath = require.resolve(`${platformPackage.packageName}/package.json`);
    const packageRoot = dirname(manifestPath);
    const sourceExecutable = validateNativePackage(packageRoot, platformKey, platformPackage);
    return process.platform === "win32"
      ? materializeWindowsWorker(packageRoot, sourceExecutable, platformPackage)
      : sourceExecutable;
  } catch (error) {
    const source = fileURLToPath(import.meta.url);
    throw new Error(
      `The native package ${platformPackage.packageName} is missing or invalid for ${platformKey}. ` +
        `Reinstall @conghuy113/recaptcha-solver and do not omit optional dependencies. ` +
        `(loaded from ${source})`,
      { cause: error },
    );
  }
}
