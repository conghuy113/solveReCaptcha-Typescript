// SPDX-License-Identifier: AGPL-3.0-only

import { solveReCaptcha } from "../src/index.js";

if (process.env.RECAPTCHA_SOLVER_LIVE_APPROVED !== "YES") {
  throw new Error(
    "Set RECAPTCHA_SOLVER_LIVE_APPROVED=YES only for a page you own or are authorized to test.",
  );
}

const targetUrl = process.env.RECAPTCHA_SOLVER_TARGET_URL?.trim();
if (!targetUrl) throw new Error("RECAPTCHA_SOLVER_TARGET_URL is required.");

const port = Number(process.env.RECAPTCHA_SOLVER_CDP_PORT ?? "9222");
const clickCheckbox = process.env.RECAPTCHA_SOLVER_CLICK_CHECKBOX !== "0";
const result = await solveReCaptcha({ targetUrl, port, clickCheckbox });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
