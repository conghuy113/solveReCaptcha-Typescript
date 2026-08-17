// SPDX-License-Identifier: AGPL-3.0-only

import { ensureModels } from "./models/manager.js";

async function main(): Promise<void> {
  if (process.env.RECAPTCHA_SOLVER_SKIP_MODEL_DOWNLOAD === "1") {
    process.stdout.write("Skipping reCAPTCHA model download by explicit configuration.\n");
    return;
  }
  const models = await ensureModels();
  process.stdout.write(`Verified reCAPTCHA models in ${models.directory}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`Failed to install reCAPTCHA models: ${String(error)}\n`);
  process.exitCode = 1;
});
