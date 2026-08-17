// SPDX-License-Identifier: AGPL-3.0-only

import { CdpChrome } from "../src/browser/cdp/index.js";

const port = Number.parseInt(process.env.CDP_PORT ?? "9222", 10);
const targetUrl = process.env.CDP_TARGET_URL;

if (!targetUrl) {
  throw new Error("Set CDP_TARGET_URL to an authorized page that is already open in Chrome.");
}

const chrome = await CdpChrome.connect(port);
try {
  const tab = await chrome.selectTab(targetUrl);
  process.stdout.write(`${JSON.stringify({ browser: chrome.browserVersion, url: await tab.url(), title: await tab.title() })}\n`);
} finally {
  await chrome.close();
}
