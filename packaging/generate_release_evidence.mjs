/** Generate a CycloneDX SBOM and reviewed license inventory from a packed package. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policyPath = join(projectRoot, "packaging", "license-policy.json");

function fail(message) {
  throw new Error(message);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function packedManifest(tarball) {
  const archive = gunzipSync(readFileSync(tarball));
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/u, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const contentOffset = offset + 512;
    if (name === "package/package.json") {
      const manifest = JSON.parse(
        archive.subarray(contentOffset, contentOffset + size).toString("utf8"),
      );
      if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
        fail(`Tarball has invalid package metadata: ${tarball}`);
      }
      return manifest;
    }
    offset = contentOffset + Math.ceil(size / 512) * 512;
  }
  fail(`Tarball has no package/package.json: ${tarball}`);
}

function run(command, args, options = {}) {
  let executable = command;
  let executableArguments = args;
  if (process.platform === "win32") {
    executable = process.env.ComSpec || "cmd.exe";
    executableArguments = ["/d", "/s", "/c", "call", command, ...args];
  }
  const result = spawnSync(executable, executableArguments, {
    encoding: "utf8",
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10 * 60_000,
    ...options,
  });
  if (result.error || result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} failed with ${String(result.status)}\n` +
        `stdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`,
    );
  }
  return result.stdout.trim();
}

function componentLicense(component) {
  if (!Array.isArray(component.licenses)) return undefined;
  const expressions = component.licenses
    .map((entry) => {
      if (typeof entry?.expression === "string") return entry.expression.trim();
      if (typeof entry?.license?.id === "string") return entry.license.id.trim();
      if (typeof entry?.license?.name === "string") return entry.license.name.trim();
      return undefined;
    })
    .filter(Boolean);
  return expressions.length > 0 ? expressions.join(" OR ") : undefined;
}

function componentRepository(component) {
  if (!Array.isArray(component.externalReferences)) return undefined;
  return component.externalReferences.find(
    (reference) => reference?.type === "vcs" && typeof reference.url === "string",
  )?.url;
}

const [tarballArgument, outputArgument] = process.argv.slice(2);
if (!tarballArgument || !outputArgument) {
  fail("Usage: node generate_release_evidence.mjs <package.tgz> <output-directory>");
}

const tarball = resolve(tarballArgument);
const outputDirectory = resolve(outputArgument);
if (!statSync(tarball).isFile()) fail(`Package tarball does not exist: ${tarball}`);
if (existsSync(outputDirectory)) {
  if (readdirSync(outputDirectory).length > 0) fail(`Evidence directory must be empty: ${outputDirectory}`);
} else {
  mkdirSync(outputDirectory, { recursive: true });
}

const policy = JSON.parse(readFileSync(policyPath, "utf8"));
if (policy.schemaVersion !== 1 || !Array.isArray(policy.allowedExpressions)) {
  fail(`Invalid license policy: ${policyPath}`);
}
const allowedExpressions = new Set(policy.allowedExpressions);
const manifest = packedManifest(tarball);
const temporaryRoot = mkdtempSync(join(tmpdir(), "recaptcha-release-evidence-"));
const npmCommand = process.env.RECAPTCHA_SOLVER_NPM_COMMAND || "npm";

try {
  writeFileSync(
    join(temporaryRoot, "package.json"),
    `${JSON.stringify({
      name: "recaptcha-release-evidence-consumer",
      version: "0.0.0",
      private: true,
      dependencies: { [manifest.name]: `file:${tarball}` },
    }, null, 2)}\n`,
  );
  run(npmCommand, ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: temporaryRoot,
    env: { ...process.env, RECAPTCHA_SOLVER_SKIP_MODEL_DOWNLOAD: "1" },
  });

  const sbomText = run(
    npmCommand,
    [
      "sbom",
      "--package-lock-only",
      "--sbom-format=cyclonedx",
      "--sbom-type=library",
      "--omit=dev",
    ],
    { cwd: temporaryRoot },
  );
  const sbom = JSON.parse(sbomText);
  if (sbom.bomFormat !== "CycloneDX" || !Array.isArray(sbom.components)) {
    fail("npm produced an invalid CycloneDX SBOM.");
  }

  const dependencies = [];
  const seen = new Set();
  for (const component of sbom.components) {
    if (!component || typeof component !== "object") continue;
    const name = component.name;
    const version = component.version;
    if (typeof name !== "string" || typeof version !== "string") continue;
    const key = `${name}@${version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const license = componentLicense(component);
    if (!license) fail(`Dependency has no declared license: ${key}`);
    const repository = componentRepository(component);
    dependencies.push({
      name,
      version,
      license,
      ...(repository ? { repository } : {}),
    });
  }
  dependencies.sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  );
  if (!dependencies.some((dependency) => dependency.name === manifest.name)) {
    fail(`License inventory does not contain the packed package: ${manifest.name}`);
  }
  const rejected = dependencies.filter(
    (dependency) => !allowedExpressions.has(dependency.license),
  );
  if (rejected.length > 0) {
    fail(
      `Unreviewed dependency licenses: ${rejected
        .map((dependency) => `${dependency.name}@${dependency.version} (${dependency.license})`)
        .join(", ")}`,
    );
  }

  const generatedAt = new Date().toISOString();
  const sbomPath = join(outputDirectory, "sbom.cdx.json");
  const licensesPath = join(outputDirectory, "dependency-licenses.json");
  writeFileSync(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);
  writeFileSync(
    licensesPath,
    `${JSON.stringify({
      schemaVersion: 1,
      generatedAt,
      package: { name: manifest.name, version: manifest.version },
      allowedExpressions: [...allowedExpressions].sort(),
      dependencies,
    }, null, 2)}\n`,
  );
  writeFileSync(
    join(outputDirectory, "release-evidence.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      generatedAt,
      package: { name: manifest.name, version: manifest.version },
      artifacts: {
        package: { file: tarball.split(/[\\/]/u).pop(), sha256: sha256(tarball) },
        sbom: { file: "sbom.cdx.json", sha256: sha256(sbomPath) },
        licenses: { file: "dependency-licenses.json", sha256: sha256(licensesPath) },
      },
      tools: { node: process.version, npm: run(npmCommand, ["--version"]) },
    }, null, 2)}\n`,
  );
  process.stdout.write(
    `Generated release evidence for ${manifest.name}@${manifest.version} with ` +
      `${String(dependencies.length)} licensed dependencies.\n`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
