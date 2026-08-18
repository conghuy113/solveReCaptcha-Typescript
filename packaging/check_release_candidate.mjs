/** Validate that a package release tag points at the exact publishable source. */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = JSON.parse(
  readFileSync(
    join(projectRoot, "npm", "recaptcha-solver", "package.json"),
    "utf8",
  ),
);
const modelManifest = JSON.parse(
  readFileSync(
    join(projectRoot, "npm", "recaptcha-solver", "model-manifest.json"),
    "utf8",
  ),
);
const [tag, mode] = process.argv.slice(2);

if (!tag)
  throw new Error(
    "Usage: node check_release_candidate.mjs <vX.Y.Z> [--manifest-only]",
  );
if (tag !== `v${packageManifest.version}`) {
  throw new Error(
    `Release tag ${tag} does not match package version ${packageManifest.version}.`,
  );
}
if (
  packageManifest.private === true ||
  packageManifest.license !== "AGPL-3.0-only"
) {
  throw new Error(
    "The release candidate is not a public AGPL-3.0-only package.",
  );
}
if (
  packageManifest.repository?.url !==
  "git+https://github.com/conghuy113/solveReCaptcha-Typescript.git"
) {
  throw new Error(
    "Package repository metadata does not match the public source repository.",
  );
}
if (
  typeof modelManifest.releaseTag !== "string" ||
  !Array.isArray(modelManifest.models) ||
  modelManifest.models.length !== 2 ||
  !modelManifest.models.every((model) =>
    String(model.url).includes(
      `/releases/download/${modelManifest.releaseTag}/`,
    ),
  )
) {
  throw new Error(
    "The package does not reference one immutable two-model release.",
  );
}

if (mode !== "--manifest-only") {
  const git = (...args) => {
    const result = spawnSync("git", args, {
      cwd: projectRoot,
      encoding: "utf8",
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed: ${result.stderr || result.error}`,
      );
    }
    return result.stdout.trim();
  };
  const head = git("rev-parse", "HEAD");
  const taggedCommit = git("rev-list", "-n", "1", tag);
  if (head !== taggedCommit)
    throw new Error(`Release tag ${tag} does not point at HEAD.`);
}

process.stdout.write(
  `Release candidate ${tag} is aligned with model release ${modelManifest.releaseTag}.\n`,
);
