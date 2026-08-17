/** Install the packed npm library and verify its public TypeScript-only API. */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

function fail(message) {
  throw new Error(message);
}

function packageName(tarball) {
  const archive = gunzipSync(readFileSync(tarball));
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/u, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const contentOffset = offset + 512;
    if (name === "package/package.json") {
      const manifest = JSON.parse(archive.subarray(contentOffset, contentOffset + size).toString("utf8"));
      if (typeof manifest.name !== "string") fail(`Tarball has no package name: ${tarball}`);
      return manifest.name;
    }
    offset = contentOffset + Math.ceil(size / 512) * 512;
  }
  fail(`Tarball has no package/package.json: ${tarball}`);
}

function run(command, args, options = {}) {
  let executable = command;
  let executableArguments = args;
  if (process.platform === "win32" && options.shell !== false) {
    executable = process.env.ComSpec || "cmd.exe";
    executableArguments = ["/d", "/s", "/c", "call", command, ...args];
  }
  const { shell: _shell, ...spawnOptions } = options;
  const result = spawnSync(executable, executableArguments, {
    encoding: "utf8",
    shell: false,
    ...spawnOptions,
  });
  if (result.error || result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} failed with ${String(result.status)}\n` +
        `stdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`,
    );
  }
  return result;
}

function withoutPythonPath(environment) {
  const pathEntries = (environment.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry && !entry.toLowerCase().includes("python") && !entry.includes(".venv"));
  return { ...environment, PATH: pathEntries.join(delimiter) };
}

const [coreArgument] = process.argv.slice(2);
if (!coreArgument) fail("Usage: node smoke_npm_install.mjs <core.tgz>");
const coreTarball = resolve(coreArgument);
const tempRoot = mkdtempSync(join(tmpdir(), "recaptcha-npm-smoke-"));
const npmCommand = process.env.RECAPTCHA_SOLVER_NPM_COMMAND || "npm";

try {
  const coreName = packageName(coreTarball);
  writeFileSync(
    join(tempRoot, "package.json"),
    JSON.stringify({
      name: "recaptcha-solver-install-smoke",
      private: true,
      type: "module",
      dependencies: { [coreName]: `file:${coreTarball}` },
    }, null, 2),
  );
  run(npmCommand, ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: tempRoot });

  const consumerPath = join(tempRoot, "consumer.mjs");
  writeFileSync(consumerPath, `
    import * as solver from "@conghuy113/recaptcha-solver";
    if (JSON.stringify(Object.keys(solver)) !== JSON.stringify(["solveReCaptcha"])) {
      throw new Error("The package exports an unexpected runtime API.");
    }
    try {
      await solver.solveReCaptcha({ targetUrl: "", port: 0, clickCheckbox: false });
      throw new Error("Expected public option validation to reject.");
    } catch (error) {
      if (!(error instanceof TypeError) || !String(error.message).includes("targetUrl")) throw error;
    }
    console.log("Packed TypeScript public API loaded and validated without Python.");
  `);

  const smokeEnvironment = withoutPythonPath(process.env);
  smokeEnvironment.RECAPTCHA_SOLVER_SKIP_MODEL_DOWNLOAD = "1";
  const result = run(process.execPath, [consumerPath], {
    cwd: tempRoot,
    env: smokeEnvironment,
    shell: false,
    timeout: 120_000,
  });
  process.stdout.write(result.stdout);

  const installedRoot = join(tempRoot, "node_modules", "@conghuy113", "recaptcha-solver");
  const installedManifest = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8"));
  if (installedManifest.optionalDependencies) fail("Packed library still declares platform workers.");
  const bundle = readdirSync(join(installedRoot, "dist"))
    .filter((file) => file.endsWith(".js"))
    .map((file) => readFileSync(join(installedRoot, "dist", file), "utf8"))
    .join("\n");
  for (const forbidden of ["WorkerClient", "recaptcha-solver-worker", "resolveWorkerBinary"]) {
    if (bundle.includes(forbidden)) fail(`Packed bundle contains removed runtime: ${forbidden}`);
  }
  console.log(`npm install smoke test passed for ${coreName}.`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
