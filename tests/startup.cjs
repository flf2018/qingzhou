// Slow privilege checks must not delay a visible, functional desktop window.
const { app } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
app.disableHardwareAcceleration();
app.setPath(
    "userData",
    fs.mkdtempSync(path.join(os.tmpdir(), "chenglian-startup-")),
);
let window,
    release,
    checks = 0;
const pending = new Promise((resolve) => {
    release = resolve;
});
const name = require.resolve("../electron/tun.cjs");
const original = require(name);
require.cache[name].exports = {
    ...original,
    isAdministrator: () => {
        assert.ok(
            window.isVisible(),
            "Privilege query started before the window was shown",
        );
        checks++;
        return pending;
    },
    elevate: async () => {
        throw Error("Unexpected elevation before permission query resolved");
    },
};
const timer = setTimeout(() => app.exit(1), 15000);
app.on("browser-window-created", (_event, created) => {
    window = created;
    window.once("show", () =>
        setImmediate(async () => {
            try {
                for (let i = 0; i < 100 && !checks; i++)
                    await new Promise((resolve) => setTimeout(resolve, 10));
                const initial = await window.webContents.executeJavaScript(
                    "window.desktop.snapshot()",
                );
                assert.equal(initial.ok, true);
                assert.equal(initial.data.administratorChecked, false);
                assert.equal(checks, 1);
                let finished = false;
                const enabling = window.webContents
                    .executeJavaScript("window.desktop.setTun(true)")
                    .then((result) => {
                        finished = true;
                        return result;
                    });
                await new Promise((resolve) => setTimeout(resolve, 100));
                assert.equal(
                    finished,
                    false,
                    "TUN must await the in-flight permission query",
                );
                assert.equal(
                    checks,
                    1,
                    "Concurrent checks must share one promise",
                );
                release(true);
                const enabled = await enabling;
                assert.equal(enabled.ok, true);
                assert.equal(enabled.data.administrator, true);
                assert.equal(enabled.data.administratorChecked, true);
                assert.equal(enabled.data.tunEnabled, true);
                assert.equal(
                    (
                        await window.webContents.executeJavaScript(
                            "window.desktop.setTun(false)",
                        )
                    ).ok,
                    true,
                );
                console.log(
                    "Visible window and IPC are ready before privilege check completes; TUN waits for the shared result.",
                );
                clearTimeout(timer);
                app.quit();
            } catch (error) {
                console.error(error);
                clearTimeout(timer);
                app.exit(1);
            }
        }),
    );
});
require("../electron/main.cjs");
