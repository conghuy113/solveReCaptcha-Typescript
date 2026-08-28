// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { CdpChrome } from "../src/browser/cdp/index.js";
import { solveReCaptcha } from "../src/index.js";
import type { SolveReCaptchaResult } from "../src/types.js";

if (process.env.RECAPTCHA_SOLVER_DEBUG_APPROVED !== "YES") {
  throw new Error(
    "Set RECAPTCHA_SOLVER_DEBUG_APPROVED=YES only for a page you own or are authorized to test.",
  );
}

const targetUrl = process.env.RECAPTCHA_SOLVER_TARGET_URL?.trim();
if (!targetUrl) throw new Error("RECAPTCHA_SOLVER_TARGET_URL is required.");
const resolvedTargetUrl = targetUrl;
const port = Number(process.env.RECAPTCHA_SOLVER_CDP_PORT ?? "9222");
const clickCheckbox = process.env.RECAPTCHA_SOLVER_CLICK_CHECKBOX !== "0";
const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const debugDirectory = fileURLToPath(new URL(`../../../Debug/${timestamp}/`, import.meta.url));
await mkdir(debugDirectory, { recursive: true });

async function capture(name: string): Promise<void> {
  const chrome = await CdpChrome.connect(port);
  try {
    const browser = await chrome.selectTab(resolvedTargetUrl);
    const response = await browser.selectedPage.transport.call(
      "Page.captureScreenshot",
      { format: "png", fromSurface: true, captureBeyondViewport: true },
      { sessionId: browser.selectedPage.sessionId },
    );
    if (typeof response.data !== "string" || !response.data) {
      throw new Error("Chrome returned no screenshot data.");
    }
    await writeFile(`${debugDirectory}/${name}.png`, Buffer.from(response.data, "base64"));
  } finally {
    await chrome.close();
  }
}

function sanitized(result: SolveReCaptchaResult): Record<string, unknown> {
  return {
    ...result,
    token: result.token ? {
      length: result.token.length,
      sha256: createHash("sha256").update(result.token).digest("hex"),
    } : null,
    cookies: { count: result.cookies.length },
  };
}

await capture("before");
let record: Record<string, unknown>;
try {
  const result = await solveReCaptcha({ targetUrl: resolvedTargetUrl, port, clickCheckbox });
  record = { outcome: "resolved", result: sanitized(result) };
} catch (error) {
  record = {
    outcome: "rejected",
    error: error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : String(error),
  };
} finally {
  await capture("after");
}
await writeFile(
  `${debugDirectory}/interactions.json`,
  `${JSON.stringify(record, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`Debug artifacts written to ${debugDirectory}\n`);
