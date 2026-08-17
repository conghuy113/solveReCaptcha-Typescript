// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const testDirectory = fileURLToPath(new URL("../test/", import.meta.url));
const testFiles = readdirSync(testDirectory)
  .filter((file) => file.endsWith(".test.ts"))
  .sort()
  .map((file) => fileURLToPath(new URL(`../test/${file}`, import.meta.url)));

if (testFiles.length === 0) throw new Error("No TypeScript test files were found.");

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...testFiles], {
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
