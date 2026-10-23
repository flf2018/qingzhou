// Run with Electron, not Node. Isolate all app data from real user profiles.
const { app, dialog, Tray } = require("electron");
let trayMenu, systemTray;
const originalSetMenu = Tray.prototype.setContextMenu;
Tray.prototype.setContextMenu = function (menu) {
    trayMenu = menu;
    systemTray = this;
    return originalSetMenu.call(this, menu);
};
app.disableHardwareAcceleration();
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2rayn-ui-"));
app.setPath("userData", directory);
const fixture = path.join(directory, "integration-test.json");
fs.writeFileSync(
    fixture,
    JSON.stringify({
        inbounds: [{ protocol: "socks", listen: "127.0.0.1", port: 10808 }],
        outbounds: [{ protocol: "freedom" }],
    }),
);
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] });
let succeeded = false;
const timeout = setTimeout(() => {
    console.error("UI smoke test timed out");
    app.exit(1);
}, 20000);
app.on("browser-window-created", (_event, window) => {
    window.webContents.on("did-finish-load", async () => {
        try {
            assert.ok(
                window
                    .getSize()
                    .every(
                        (value, index) =>
                            Math.abs(value - [1080, 720][index]) <= 3,
                    ),
                "Default window should be 1080×720 (allow Windows DPI rounding)",
            );
            assert.deepEqual(window.getMinimumSize(), [960, 640]);
            const errors = [];
            window.webContents.on("console-message", (_event, details) => {
                if (details.level === "error") errors.push(details.message);
            });
            const result = await window.webContents
                .executeJavaScript(`(async () => {
        const snapshot = await window.desktop.snapshot();
        const imported = await window.desktop.importConfig();
        const profile = imported.data.profiles[0];
        const start = await window.desktop.start(profile.id);
        const removed = await window.desktop.remove(profile.id);
        document.querySelectorAll('nav button')[2].click();
        await new Promise(resolve => setTimeout(resolve, 100));
        const badTun = await window.desktop.setTun('invalid');
        const tunOff = await window.desktop.setTun(false);
        const badMode = await window.desktop.setRoutingMode('invalid');
        const globalMode = await window.desktop.setRoutingMode('global');
        const smartMode = await window.desktop.setRoutingMode('smart');
        return { snapshot, imported, start, removed, badTun, tunOff, badMode, globalMode, smartMode, text: document.body.innerText, node: typeof window.require };
      })()`);
            assert.equal(result.snapshot.ok, true);
            assert.equal(result.snapshot.data.profiles.length, 0);
            assert.equal(result.snapshot.data.tunEnabled, false);
            assert.equal(typeof result.snapshot.data.administrator, "boolean");
            assert.equal(result.badTun.ok, false);
            assert.equal(result.badMode.ok, false);
            assert.equal(result.snapshot.data.routingMode, "smart");
            assert.equal(result.globalMode.data.routingMode, "global");
            assert.equal(result.smartMode.data.routingMode, "smart");
            assert.equal(systemTray.isDestroyed(), false);
            assert.ok(trayMenu.items.some((item) => item.label === "打开轻舟"));
            assert.equal(result.tunOff.data.tunActive, false);
            assert.ok(!result.text.includes("TUN 全局接管"));
            assert.equal(result.imported.data.profiles[0].kind, "Xray");
            assert.equal(result.imported.data.profiles[0].config, undefined);
            assert.equal(result.start.ok, false);
            assert.match(result.start.error, /没有 HTTP 入站/);
            assert.equal(result.removed.data.profiles.length, 0);
            assert.equal(result.node, "undefined");
            assert.ok(result.text.includes("内置代理引擎"));
            assert.ok(result.text.includes("已内置 · v"));
            await window.webContents.executeJavaScript(
                `document.querySelectorAll('nav button')[0].click()`,
            );
            await new Promise((resolve) => setTimeout(resolve, 100));
            const nodeText = await window.webContents.executeJavaScript(
                "document.body.innerText",
            );
            assert.ok(
                !nodeText.includes("integration-test"),
                "Deleted config must disappear from the rendered UI",
            );
            assert.ok(nodeText.includes("添加你的第一个节点"));
            assert.ok(nodeText.includes("网络测速"));
            assert.ok(nodeText.includes("TUN 全局接管"));
            assert.ok(nodeText.includes("开启 TUN"));
            assert.ok(nodeText.includes("智能分流"));
            assert.ok(nodeText.includes("全局代理"));
            trayMenu.items.find((item) => item.label === "隐藏到托盘").click();
            assert.equal(window.isVisible(), false);
            systemTray.emit("double-click");
            assert.equal(window.isVisible(), true);
            window.close();
            assert.equal(window.isDestroyed(), false);
            assert.equal(window.isVisible(), false);
            assert.equal(systemTray.isDestroyed(), false);
            systemTray.emit("click");
            assert.equal(window.isVisible(), true);
            const layout = await window.webContents.executeJavaScript(
                `({viewport:innerWidth,width:document.documentElement.scrollWidth})`,
            );
            assert.ok(
                layout.width <= layout.viewport,
                "Compact layout must not overflow horizontally",
            );
            assert.ok(!/Electron|ELECTRON|Vue|v2rayN/.test(nodeText));
            const image = await window.webContents.capturePage();
            const screenshot = path.join(directory, "desktop.png");
            fs.writeFileSync(screenshot, image.toPNG());
            assert.deepEqual(errors, []);
            succeeded = true;
            console.log(`UI smoke passed; screenshot: ${screenshot}`);
            clearTimeout(timeout);
            trayMenu.items.find((item) => item.label === "退出轻舟").click();
        } catch (error) {
            console.error(error);
            clearTimeout(timeout);
            app.exit(1);
        }
    });
});
app.on("will-quit", () => {
    if (!succeeded) process.exitCode = 1;
});
app.on("quit", () => {
    if (succeeded) assert.equal(systemTray.isDestroyed(), true);
});
require("../electron/main.cjs");
