// Exercise the real main-process IPC flow, replacing privileged OS operations.
const { app } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
app.disableHardwareAcceleration();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chenglian-recovery-"));
app.setPath("userData", directory);
const config = {
    inbounds: [{ protocol: "http", listen: "127.0.0.1", port: 10808 }],
    outbounds: [{ protocol: "freedom" }],
};
fs.writeFileSync(
    path.join(directory, "profiles.json"),
    JSON.stringify({
        profiles: [
            {
                id: "test",
                name: "recovery",
                kind: "Xray",
                config,
                host: "127.0.0.1",
                port: 10808,
            },
        ],
        selectedId: "test",
        binaries: {},
        systemProxy: true,
        tunEnabled: true,
    }),
);
function replace(module, update) {
    const name = require.resolve(module);
    const original = require(name);
    require.cache[name].exports = { ...original, ...update };
}
replace("../electron/core.cjs", {
    CoreController: class {
        constructor(_dir, changed) {
            this.changed = changed;
            this.child = null;
            this.state = { phase: "stopped" };
        }
        async start(profile) {
            this.child = {};
            this.state = { phase: "running", profileId: profile.id };
            this.changed(this.state);
        }
        async stop() {
            this.child = null;
            this.state = { phase: "stopped" };
            this.changed(this.state);
        }
    },
});
replace("../electron/proxy.cjs", {
    SystemProxy: class {
        constructor() {
            this.active = false;
        }
        async restore() {
            this.active = false;
        }
        async enable() {
            this.active = true;
        }
    },
});
replace("../electron/tun.cjs", {
    isAdministrator: async () => true,
    physicalNetwork: async () => ({
        interfaceName: "fixture",
        dns: "192.0.2.53",
    }),
    TunController: class {
        constructor(_dir, _host, changed) {
            this.changed = changed;
            this.child = null;
            this.phase = "stopped";
        }
        get active() {
            return this.phase === "running";
        }
        update(phase) {
            this.phase = phase;
            this.changed(phase);
        }
        async start() {
            this.child = {};
            this.update("checking");
        }
        async stop() {
            this.child = null;
            this.update("stopped");
        }
    },
});
replace("../electron/measure.cjs", { transfer: async () => ({ status: 204 }) });
replace("../electron/connectivity.cjs", {
    systemProbe: async () => {
        throw Error("Simulated OS network failure");
    },
});
const timer = setTimeout(() => app.exit(1), 15000);
app.on("browser-window-created", (_event, window) =>
    window.webContents.once("did-finish-load", async () => {
        try {
            const result = await window.webContents.executeJavaScript(
                `(async()=>{const start=await window.desktop.start('test'); const after=await window.desktop.snapshot();const off=await window.desktop.setTun(false);return {start,after,off};})()`,
            );
            assert.equal(result.start.ok, false);
            assert.match(result.start.error, /回退到系统代理/);
            assert.equal(result.after.data.tunEnabled, false);
            assert.equal(result.after.data.tunActive, false);
            assert.equal(result.after.data.core.phase, "running");
            assert.equal(result.after.data.proxyActive, true);
            assert.equal(result.off.ok, true);
            assert.equal(result.off.data.core.phase, "stopped");
            assert.equal(result.off.data.proxyActive, false);
            console.log(
                "TUN failure rolls back to system proxy; node-page switch can stop an active connection. No OS settings changed.",
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
require("../electron/main.cjs");
