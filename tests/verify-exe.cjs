// Validate the actual distributed executable using an isolated Chromium profile.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { version } = require("../package.json");
const net = require("node:net");
const http = require("node:http");
async function freePort() {
    const server = net.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
}
function proxyRequest(port, targetPort) {
    return new Promise((resolve, reject) => {
        const request = http.get(
            {
                host: "127.0.0.1",
                port,
                path: `http://127.0.0.1:${targetPort}/standalone`,
                headers: {
                    Host: `127.0.0.1:${targetPort}`,
                    Connection: "close",
                },
                timeout: 5000,
            },
            (response) => {
                const chunks = [];
                response.on("data", (chunk) => chunks.push(chunk));
                response.on("end", () =>
                    resolve(Buffer.concat(chunks).toString()),
                );
            },
        );
        request.once("timeout", () =>
            request.destroy(new Error("Local proxy request timed out")),
        );
        request.once("error", reject);
    });
}

function connect(url) {
    const socket = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        const entry = pending.get(message.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
    });
    const ready = new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", reject, { once: true });
    });
    return {
        socket,
        async call(method, params = {}) {
            await ready;
            return new Promise((resolve, reject) => {
                const requestId = ++id;
                const timer = setTimeout(() => {
                    pending.delete(requestId);
                    reject(new Error(`${method} timed out`));
                }, 8000);
                pending.set(requestId, { resolve, reject, timer });
                socket.send(JSON.stringify({ id: requestId, method, params }));
            });
        },
    };
}

(async () => {
    const binary = path.resolve(
        process.argv[2] || `release/QingZhou-${version}-portable.exe`,
    );
    const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "v2rayn-exe-check-"),
    );
    await fs.access(binary);
    await fs.access(path.join(__dirname, "../build/TunHost.exe"));
    const child = spawn(
        binary,
        [
            "--remote-debugging-port=0",
            "--disable-gpu",
            `--user-data-dir=${directory}`,
        ],
        { windowsHide: true, stdio: "ignore" },
    );
    let browser, page, localServer;
    const exited = once(child, "exit");
    try {
        let endpoint;
        for (let attempt = 0; attempt < 450; attempt++) {
            try {
                const [port, browserPath] = (
                    await fs.readFile(
                        path.join(directory, "DevToolsActivePort"),
                        "utf8",
                    )
                )
                    .trim()
                    .split(/\r?\n/);
                endpoint = { port, browserPath };
                break;
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
            }
            await delay(100);
        }
        assert.ok(
            endpoint,
            "Packaged application did not start its browser process",
        );
        browser = connect(
            `ws://127.0.0.1:${endpoint.port}${endpoint.browserPath}`,
        );
        let target;
        for (let attempt = 0; attempt < 100; attempt++) {
            const targets = await (
                await fetch(`http://127.0.0.1:${endpoint.port}/json/list`)
            ).json();
            target = targets.find(
                (item) =>
                    item.type === "page" &&
                    item.url.includes("app.asar/dist/index.html"),
            );
            if (target) break;
            await delay(100);
        }
        assert.ok(target, "Packaged app.asar page was not loaded");
        page = connect(target.webSocketDebuggerUrl);
        await page.call("Emulation.setDeviceMetricsOverride", {
            width: 1080,
            height: 720,
            deviceScaleFactor: 1,
            mobile: false,
        });
        const evaluated = await page.call("Runtime.evaluate", {
            expression: `(async () => {
        for (let i = 0; i < 100 && !document.querySelector('h1'); i++) await new Promise(resolve => setTimeout(resolve, 50));
        return { title: document.title, text: document.body.innerText, node: typeof window.require, snapshot: await window.desktop.snapshot() };
      })()`,
            awaitPromise: true,
            returnByValue: true,
        });
        assert.ok(
            !evaluated.exceptionDetails,
            JSON.stringify(evaluated.exceptionDetails),
        );
        const result = evaluated.result.value;
        assert.equal(result.title, "轻舟");
        assert.ok(!/Electron|ELECTRON|Vue|v2rayN/.test(result.text));
        assert.equal(result.node, "undefined");
        assert.ok(result.text.includes("代理节点"));
        assert.ok(result.text.includes("网络测速"));
        assert.equal(result.snapshot.ok, true);
        assert.equal(result.snapshot.data.profiles.length, 0);
        assert.equal(result.snapshot.data.routingMode, "smart");
        assert.ok(result.text.includes("智能分流"));
        assert.ok(result.text.includes("全局代理"));
        assert.equal(result.snapshot.data.tunEnabled, false);
        assert.equal(result.snapshot.data.tunActive, false);
        assert.equal(typeof result.snapshot.data.administrator, "boolean");
        const contrast = await page.call("Runtime.evaluate", {
            expression: `(() => {
                const rgb = text => (text.match(/[\\d.]+/g) || []).map(Number);
                const luminance = values => values.slice(0,3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum,v,i) => sum + v * [.2126,.7152,.0722][i], 0);
                const background = element => { for (let node=element; node; node=node.parentElement) { const values=rgb(getComputedStyle(node).backgroundColor); if (values.length===3 || values[3]===1) return values; } return [255,255,255]; };
                return ['.brand small','.workspace small','.nav-label','.edition-tag','.version','.eyebrow','h1 + p','.section-kicker','.connection-info > p','.connection-action > span','.metrics small','.view-hint','.empty-state p'].map(selector => {
                    const element = document.querySelector(selector); if (!element || !element.getClientRects().length) return null;
                    const a=luminance(rgb(getComputedStyle(element).color)), b=luminance(background(element));
                    return {selector, ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
                }).filter(Boolean);
            })()`,
            returnByValue: true,
        });
        for (const row of contrast.result.value)
            assert.ok(
                row.ratio >= 4.5,
                `${row.selector} contrast ${row.ratio.toFixed(2)} is too low`,
            );
        console.log(
            `Readable text verified: ${contrast.result.value.length} styles have contrast >= 4.5:1.`,
        );
        const settings = await page.call("Runtime.evaluate", {
            expression: `(async () => { document.querySelectorAll('nav button')[2].click(); await new Promise(requestAnimationFrame); return document.body.innerText; })()`,
            awaitPromise: true,
            returnByValue: true,
        });
        assert.ok(settings.result.value.includes(`轻舟 · v${version}`));
        assert.ok(!settings.result.value.includes("TUN 全局接管"));
        assert.ok(result.text.includes("TUN 全局接管"));
        assert.ok(!/Electron|ELECTRON|Vue|v2rayN/.test(settings.result.value));
        const settingsImage = await page.call("Page.captureScreenshot", {
            format: "png",
        });
        await fs.writeFile(
            path.join(directory, "packaged-settings.png"),
            Buffer.from(settingsImage.data, "base64"),
        );
        await page.call("Runtime.evaluate", {
            expression: `document.querySelectorAll('nav button')[0].click()`,
        });
        assert.ok(result.snapshot.data.bundled.Xray);
        assert.ok(result.snapshot.data.bundled["sing-box"]);
        async function ipc(method, ...args) {
            const response = await page.call("Runtime.evaluate", {
                expression: `window.desktop[${JSON.stringify(method)}](...${JSON.stringify(args)})`,
                awaitPromise: true,
                returnByValue: true,
            });
            assert.ok(
                !response.exceptionDetails,
                JSON.stringify(response.exceptionDetails),
            );
            assert.equal(
                response.result.value.ok,
                true,
                response.result.value.error,
            );
            return response.result.value.data;
        }
        const invalidMeasurement = await page.call("Runtime.evaluate", {
            expression: `window.desktop.measure('missing-profile', true)`,
            awaitPromise: true,
            returnByValue: true,
        });
        assert.equal(invalidMeasurement.result.value.ok, false);
        assert.match(invalidMeasurement.result.value.error, /请先选择节点/);
        await ipc("cancelMeasure");
        assert.equal(
            (await ipc("setRoutingMode", "global")).routingMode,
            "global",
        );
        assert.equal(
            (await ipc("setRoutingMode", "smart")).routingMode,
            "smart",
        );
        // Disable OS proxy changes in this isolated test profile; exercise real proxy
        // forwarding explicitly without changing the user's live Internet Settings.
        await ipc("setSystemProxy", false);
        localServer = http.createServer((_request, response) =>
            response.end("standalone-proxy-ok"),
        );
        localServer.listen(0, "127.0.0.1");
        await once(localServer, "listening");
        for (const kind of ["Xray", "sing-box"]) {
            const port = await freePort();
            const config =
                kind === "Xray"
                    ? {
                          inbounds: [
                              {
                                  protocol: "http",
                                  listen: "127.0.0.1",
                                  port,
                                  settings: {},
                              },
                          ],
                          outbounds: [
                              {
                                  protocol: "freedom",
                                  streamSettings: {
                                      network: "tcp",
                                      kcpSettings: {
                                          header: { type: "utp" },
                                          seed: "fixture-seed",
                                      },
                                  },
                              },
                          ],
                      }
                    : {
                          inbounds: [
                              {
                                  type: "mixed",
                                  listen: "127.0.0.1",
                                  listen_port: port,
                              },
                          ],
                          outbounds: [{ type: "direct" }],
                      };
            const imported = await ipc("importText", JSON.stringify(config));
            const profile = imported.profiles.at(-1);
            const connected = await ipc("start", profile.id);
            assert.equal(connected.core.phase, "running");
            assert.equal(connected.proxyActive, false);
            assert.equal(
                await proxyRequest(port, localServer.address().port),
                "standalone-proxy-ok",
            );
            const stopped = await ipc("stop");
            assert.equal(stopped.core.phase, "stopped");
            if (kind === "Xray")
                assert.ok(
                    stopped.logs.some((item) =>
                        item.message.includes("已自动兼容"),
                    ),
                );
            await ipc("remove", profile.id);
            console.log(
                `${kind}: bundled core started, forwarded a real local HTTP request, and stopped.`,
            );
        }
        await ipc("setSystemProxy", true);
        const { data } = await page.call("Page.captureScreenshot", {
            format: "png",
        });
        const screenshot = path.join(directory, "packaged-desktop.png");
        await fs.writeFile(screenshot, Buffer.from(data, "base64"));
        console.log(`Packaged EXE verified: ${binary}`);
        console.log(`Screenshot: ${screenshot}`);
    } finally {
        if (page) {
            await page
                .call("Runtime.evaluate", {
                    expression: "window.desktop.stop()",
                    awaitPromise: true,
                    returnByValue: true,
                })
                .catch(() => {});
        }
        localServer?.closeAllConnections();
        localServer?.close();
        page?.socket.close();
        if (browser) {
            await browser.call("Browser.close").catch(() => {});
            browser.socket.close();
        } else {
            child.kill();
        }
        await Promise.race([exited, delay(10000)]);
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
