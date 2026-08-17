/** Refuse npm publication when the immutable package version already exists. */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(join(projectRoot, "npm", "recaptcha-solver", "package.json"), "utf8"),
);
const encodedName = encodeURIComponent(manifest.name);
const response = await fetch(`https://registry.npmjs.org/${encodedName}/${manifest.version}`, {
  headers: { accept: "application/json" },
  redirect: "error",
  signal: AbortSignal.timeout(30_000),
});

if (response.status === 404) {
  process.stdout.write(`${manifest.name}@${manifest.version} is available for first publication.\n`);
} else if (response.ok) {
  throw new Error(`${manifest.name}@${manifest.version} already exists and cannot be replaced.`);
} else {
  throw new Error(`npm registry version check returned HTTP ${String(response.status)}.`);
}
