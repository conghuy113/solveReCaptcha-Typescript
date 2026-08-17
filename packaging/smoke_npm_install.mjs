/** Install packed npm tarballs and execute the public API without system Python. */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const shouldUseCommandInterpreter =
    process.platform === "win32" &&
    options.shell !== false &&
    (!command.includes(".") || /\.(?:cmd|bat)$/iu.test(command));
  if (shouldUseCommandInterpreter) {
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

const [coreArgument, platformArgument] = process.argv.slice(2);
if (!coreArgument || !platformArgument) {
  fail("Usage: node smoke_npm_install.mjs <core.tgz> <platform.tgz>");
}
const coreTarball = resolve(coreArgument);
const platformTarball = resolve(platformArgument);
const tempRoot = mkdtempSync(join(tmpdir(), "recaptcha-npm-smoke-"));
const npmCommand = process.env.RECAPTCHA_SOLVER_NPM_COMMAND || "npm";
const installArguments = ["install", "--offline", "--ignore-scripts"];
if (!npmCommand.toLowerCase().includes("pnpm")) {
  installArguments.push("--no-audit", "--no-fund");
}

try {
  const coreName = packageName(coreTarball);
  const platformName = packageName(platformTarball);
  writeFileSync(
    join(tempRoot, "package.json"),
    JSON.stringify(
      {
        name: "recaptcha-solver-offline-smoke",
        private: true,
        type: "module",
        dependencies: {
          [coreName]: `file:${coreTarball}`,
          [platformName]: `file:${platformTarball}`,
        },
      },
      null,
      2,
    ),
  );
  run(npmCommand, installArguments, {
    cwd: tempRoot,
  });

  const consumerPath = join(tempRoot, "consumer.mjs");
  writeFileSync(
    consumerPath,
    `
      import { solveReCaptcha } from "@conghuy113/recaptcha-solver";

      try {
        await solveReCaptcha({
          targetUrl: "https://phase3.invalid/",
          port: 65534,
          clickCheckbox: false,
        });
        throw new Error("Expected the browser connection to fail during smoke testing.");
      } catch (error) {
        if (error?.code !== "BROWSER_CONNECTION_FAILED") throw error;
        console.log("Public API started the frozen worker and warmed cached models successfully.");
      }
    `,
  );

  const smokeEnvironment = withoutPythonPath(process.env);
  smokeEnvironment.VISION_AI_RECAPTCHA_CACHE_DIR = join(tempRoot, "worker-cache");
  const result = run(process.execPath, [consumerPath], {
    cwd: tempRoot,
    env: smokeEnvironment,
    shell: false,
    timeout: 900_000,
  });
  process.stdout.write(result.stdout);

  const installedCore = JSON.parse(
    readFileSync(join(tempRoot, "node_modules", "@conghuy113", "recaptcha-solver", "package.json")),
  );
  if (installedCore.name !== "@conghuy113/recaptcha-solver") {
    fail("The installed core package has unexpected metadata.");
  }
  console.log(`Offline npm smoke test passed for ${platformName}.`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
