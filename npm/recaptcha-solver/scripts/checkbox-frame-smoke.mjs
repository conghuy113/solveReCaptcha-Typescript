// SPDX-License-Identifier: AGPL-3.0-only

// Synthetic loopback fixtures only. No Google challenge or model download is used.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { solveReCaptcha } from "../dist/index.js";

const useWss = process.argv.includes("--wss");
if (useWss && process.env.RECAPTCHA_SOLVER_TLS_FIXTURE_CHILD !== "1") {
  // Trust only this public localhost fixture, in a child process. Never change
  // the system trust store or disable certificate/hostname verification.
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--wss"], {
    env: {
      ...process.env,
      RECAPTCHA_SOLVER_TLS_FIXTURE_CHILD: "1",
      NODE_EXTRA_CA_CERTS: fileURLToPath(new URL("../test/fixtures/tls/localhost-cert.pem", import.meta.url)),
      NODE_TLS_REJECT_UNAUTHORIZED: "1",
    },
    stdio: "inherit",
    windowsHide: true,
    timeout: 120_000,
  });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}

async function localWssProxy(upstreamUrl) {
  const tlsServer = createHttpsServer({
    cert: readFileSync(new URL("../test/fixtures/tls/localhost-cert.pem", import.meta.url)),
    key: readFileSync(new URL("../test/fixtures/tls/localhost-key.pem", import.meta.url)),
  });
  const socketServer = new WebSocketServer({ noServer: true });
  const upstreams = new Set();
  const methods = [];
  let connections = 0;
  const path = "/devtools/browser/fixture?token=synthetic%2Btoken%3D";
  tlsServer.on("upgrade", (request, socket, head) => {
    if (request.url !== path) { socket.destroy(); return; }
    socketServer.handleUpgrade(request, socket, head, peer => {
      connections += 1;
      const upstream = new WebSocket(upstreamUrl);
      upstreams.add(upstream);
      const pending = [];
      peer.on("message", data => {
        const text = String(data);
        methods.push(JSON.parse(text).method);
        if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
        else pending.push(text);
      });
      upstream.on("open", () => { for (const data of pending) upstream.send(data); });
      upstream.on("message", data => { if (peer.readyState === WebSocket.OPEN) peer.send(String(data)); });
      peer.on("close", () => upstream.terminate());
      peer.on("error", () => upstream.terminate());
      upstream.on("error", () => peer.terminate());
      upstream.on("close", () => { upstreams.delete(upstream); peer.close(); });
    });
  });
  await new Promise(resolve => tlsServer.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `wss://localhost:${tlsServer.address().port}${path}`,
    methods,
    get connections() { return connections; },
    async close() {
      for (const peer of socketServer.clients) peer.terminate();
      for (const upstream of upstreams) upstream.terminate();
      await new Promise(resolve => socketServer.close(resolve));
      await new Promise(resolve => tlsServer.close(resolve));
    },
  };
}

const { default: puppeteer } = await import(process.env.PUPPETEER_CORE_MODULE ?? "puppeteer-core");
const executablePath = process.env.CHROME_EXECUTABLE_PATH;
if (!executablePath) throw new Error("CHROME_EXECUTABLE_PATH is required.");

let port;
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  const mode = url.searchParams.get("mode") ?? "oopif";
  const local = `http://127.0.0.1:${port}`;
  const remote = `http://localhost:${port}`;
  const origin = mode === "same-process" ? local : remote;
  const iframe = (id, query = "", style = "", source = origin) =>
    `<iframe name="a-${id}" data-widget="${id}" title="reCAPTCHA" style="${style}"
      src="${source}/recaptcha/enterprise/anchor?id=${id}&${query}"></iframe>`;

  if (url.pathname.endsWith("/anchor")) {
    const id = url.searchParams.get("id");
    const hidden = url.searchParams.has("hidden");
    const solved = url.searchParams.has("solved");
    const checkbox = `<span id="recaptcha-anchor" role="checkbox" aria-checked="${solved}"
      style="display:inline-block;width:28px;height:28px;border:2px solid black;${hidden ? "visibility:hidden" : ""}"
      onclick="this.setAttribute('aria-checked','true');top.postMessage({widget:'${id}',trusted:event.isTrusted},'*')">
      <span class="recaptcha-checkbox-border"></span></span>`;
    response.end(url.searchParams.has("empty") ? "<p>Empty anchor fixture</p>" :
      url.searchParams.has("delayed")
        ? `<script>setTimeout(() => document.body.innerHTML = ${JSON.stringify(checkbox)}, 1_200)</script>`
        : checkbox);
    return;
  }
  if (url.pathname === "/wrapper") {
    response.end(iframe("active", "", "", mode === "nested-cross-process" ? local : remote));
    return;
  }

  const prefix = mode === "empty-first" ? iframe("empty", "empty=1") :
    mode === "hidden-first" ? iframe("hidden", "", "display:none") :
      mode === "hidden-control-first" ? iframe("hidden", "hidden=1") :
        mode === "solved-first" ? iframe("previous", "solved=1") : "";
  const active = mode.startsWith("nested-")
    ? `<iframe src="${remote}/wrapper?mode=${mode}"></iframe>`
    : iframe("active", mode === "delayed" ? "delayed=1" : mode === "replaced" ? "empty=1" : "");
  response.end(`<textarea name="g-recaptcha-response"></textarea>${prefix}${active}
    <script>
      window.fixtureClicks = [];
      window.addEventListener('message', event => {
        if (!event.data || !event.data.widget) return;
        fixtureClicks.push(event.data);
        if (event.data.widget !== 'active') return;
        document.querySelector('textarea').value = 'synthetic-fixture-token';
        if (${JSON.stringify(mode)} === 'reordered') {
          const unrelated = document.createElement('iframe');
          unrelated.title = 'reCAPTCHA';
          unrelated.src = '${remote}/recaptcha/enterprise/anchor?id=unrelated';
          document.body.prepend(unrelated);
        }
        if (${JSON.stringify(mode)} === 'hidden-after-click') {
          document.querySelector('[data-widget="active"]').style.display = 'none';
        }
        if (${JSON.stringify(mode)} === 'replaced-after-click') {
          const old = document.querySelector('[data-widget="active"]');
          const replacement = old.cloneNode();
          replacement.src = '${remote}/recaptcha/enterprise/anchor?id=active&solved=1';
          old.replaceWith(replacement);
        }
      });
      if (${JSON.stringify(mode)} === 'replaced') setTimeout(() => {
        const old = document.querySelector('[data-widget="active"]');
        const replacement = old.cloneNode();
        replacement.src = '${remote}/recaptcha/enterprise/anchor?id=active';
        old.replaceWith(replacement);
      }, 1_200);
    </script>`);
});

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
port = server.address().port;
let browser;
let proxy;
try {
  browser = await puppeteer.launch({ executablePath, headless: true, args: ["--site-per-process"] });
  const localEndpoint = browser.wsEndpoint();
  proxy = useWss ? await localWssProxy(localEndpoint) : undefined;
  const endpoint = proxy?.endpoint ?? localEndpoint;
  await browser.disconnect();
  browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
  console.log(`Testing ${await browser.version()} over ${useWss ? "verified WSS" : "WS"}`);
  const modes = [
    "same-process", "oopif", "empty-first", "hidden-first", "hidden-control-first", "solved-first",
    "nested-same-process", "nested-cross-process", "delayed", "replaced", "reordered", "hidden-after-click",
    "replaced-after-click",
  ];
  const cases = modes.map(mode => ({ mode, connectionMode: "page" }));
  if (useWss) {
    cases.push(...["same-process", "oopif", "hidden-first", "nested-cross-process"].map(mode => ({ mode, connectionMode: "endpoint" })));
  }
  for (const { mode, connectionMode } of cases) {
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}/?mode=${mode}`);
      const session = await page.createCDPSession();
      const { targetInfos } = await session.connection().send("Target.getTargets");
      const oopifs = targetInfos.filter(target => target.type === "iframe").length;
      assert.equal(mode === "same-process" ? oopifs === 0 : oopifs > 0, true);
      await session.detach();
      const connectionsBefore = proxy?.connections;
      const result = await solveReCaptcha(connectionMode === "page"
        ? { page, clickCheckbox: true }
        : { browserWSEndpoint: endpoint, targetUrl: page.url(), clickCheckbox: true });
      assert.equal(result.status, "success");
      assert.equal(result.verification, "widget_and_token_confirmed");
      assert.equal(result.captchaType, "no_challenge");
      assert.deepEqual(await page.evaluate(() => window.fixtureClicks), [{ widget: "active", trusted: true }]);
      assert.equal(await page.evaluate(() => 1 + 1), 2, "caller page remains usable after solver cleanup");
      assert.equal(browser.connected, true);
      if (proxy) {
        assert.equal(proxy.connections, connectionsBefore + (connectionMode === "page" ? 0 : 1));
        assert.equal(proxy.methods.includes("Browser.close"), false);
      }
      console.log(`PASS ${connectionMode}/${mode} (${oopifs} OOPIFs)`);
    } finally {
      await page.close();
    }
  }
  if (proxy) {
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}/?mode=same-process`);
      await assert.rejects(solveReCaptcha({
        browserWSEndpoint: endpoint,
        targetUrl: "https://missing.invalid/",
        clickCheckbox: true,
      }), /existing Puppeteer page.*reconnect endpoint/);
      assert.equal(await page.evaluate(() => 2 + 2), 4);
      console.log("PASS endpoint/missing-tab (caller page remains usable after failure)");
    } finally { await page.close(); }
  }
  console.log(`Passed ${cases.length} synthetic checkbox fixtures${proxy ? " and missing-tab cleanup" : ""}.`);
} finally {
  await browser?.close();
  await proxy?.close();
  await new Promise(resolve => server.close(resolve));
}
